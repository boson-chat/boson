import type { IrcEvent, ServerSession } from '../engine';
import type { ChatHistoryStore } from '../history';
import { containsNickMention } from './mention';
import { SERVICE_CHANNEL, isServerWildcardTarget, isServiceSender } from './services';
import type {
  ChannelDirectory,
  ChatChannel,
  ChatMember,
  ChatMessage,
  ChatMessageKind,
  ChatState,
  MemberPrefix,
  ServerInfo,
  ServerLogEntry,
} from './chat.types';

// Maximum raw IRC events retained for the dev-tools server log. Old entries
// are evicted in FIFO order. 200 lines comfortably covers a full handshake
// (NOTICE chatter + RPL_WELCOME + MOTD + ISUPPORT bursts) plus a chunk of
// runtime traffic without ballooning memory.
const SERVER_LOG_CAP = 200;

// IRCv3 typing — auto-clear an active typer after this long without a refresh.
// The spec recommends 6s; we set it slightly higher to absorb wire jitter.
const TYPING_EXPIRY_MS = 6_000;
// Send-side throttle for `+typing=active`. Most clients refresh every 3s; the
// spec only requires that the receiver's expiry not lapse before the next
// refresh, so anything < TYPING_EXPIRY_MS is fine.
const TYPING_REFRESH_MS = 3_000;

export type ChatListener = (state: ChatState) => void;

// Persistence wiring. When both `history` and `scope` are present, ChatService
// will lazy-load a channel's scrollback on first observation and mirror every
// append/clear back into the store. When either is absent persistence is
// disabled — keeping the legacy two-arg constructor behaviour intact.
export interface ChatPersistence {
  history: ChatHistoryStore;
  scope: { userId: string; serverId: string };
}

// ChatFeedback is out-of-band UI signaling driven by slash commands.
// Examples: bad usage, unknown command, /help output. These never belong in
// the channel log (they're not from the network); the UI surfaces them as a
// transient banner or modal.
export type ChatFeedback =
  | { kind: 'error'; text: string }
  | { kind: 'help'; commands: readonly SlashCommandSpec[] };

export type ChatFeedbackListener = (f: ChatFeedback) => void;

// Self-membership event: server confirmed *we* joined, parted, or were
// kicked from a channel. Distinct from generic chat-state emits, which fire
// on every internal mutation including transient empty states from a
// freshly-rebuilt ChatService during reconnect. Persistence layers subscribe
// to THIS instead, so saved channels never get wiped by a snapshot drift.
//
// `kind`:
//   - 'join'  → user-initiated or pendingJoins-replay confirmation
//   - 'part'  → user typed /part or clicked × on the channel row
//   - 'kick'  → server kicked us out
export interface SelfMembershipEvent {
  kind: 'join' | 'part' | 'kick';
  channel: string; // server-canonical (lowercase) channel name
}

export type SelfMembershipListener = (event: SelfMembershipEvent) => void;

// Slash-command metadata. Kept here so both the dispatcher (executeCommand)
// and the UI autocomplete consume the same source of truth. When server
// capability discovery lands (ISUPPORT), filter this list before exposing
// to autocomplete.
export interface SlashCommandSpec {
  name: string;          // primary canonical name, no leading slash
  aliases?: string[];    // alternative names (also no leading slash)
  usage: string;         // human-readable usage line (e.g. '/join <channel>')
  description: string;   // one-line description
}

export const SLASH_COMMANDS: readonly SlashCommandSpec[] = [
  { name: 'join',  usage: '/join <channel>',     description: 'Join a channel' },
  { name: 'part',  aliases: ['leave'], usage: '/part [channel]', description: 'Leave the current or named channel' },
  { name: 'msg',   aliases: ['query'], usage: '/msg <nick> <text>', description: 'Send a direct message' },
  { name: 'me',    usage: '/me <action>',        description: 'Send an action (CTCP ACTION)' },
  { name: 'away',  usage: '/away [message]',     description: 'Mark yourself as away (no message ⇒ comes back)' },
  { name: 'back',  usage: '/back',               description: 'Clear your away status' },
  { name: 'clear', usage: '/clear',              description: "Clear this channel's local log" },
  { name: 'help',  usage: '/help',               description: 'List available commands' },
];

// ChatService owns channel/message state for the connected IRC session.
// It listens to engine events and exposes actions (join, send, setActive).
// Following our TS skill: single class, constructor DI, all state internal,
// subscribers see immutable snapshots.
export class ChatService {
  private channels = new Map<string, ChatChannel>();
  private activeChannel: string | null = null;
  private readonly listeners = new Set<ChatListener>();
  private readonly feedbackListeners = new Set<ChatFeedbackListener>();
  private readonly membershipListeners = new Set<SelfMembershipListener>();
  private unsubscribeEngine: (() => void) | null = null;
  // Monotonic + an instance-unique salt so message ids never collide with
  // persisted ones from a previous session. Hydrating from IndexedDB used to
  // crash Preact ("two or more children with the same key") because the
  // counter restarted at 1 every reconnect — fresh messages then re-used the
  // same numeric ids the persisted ones already had.
  private nextId = 1;
  private readonly idSalt = makeIdSalt();
  // NAMREPLY (353) lines may arrive in multiple parts for the same channel;
  // accumulate here and commit when ENDOFNAMES (366) arrives.
  private pendingMembers = new Map<string, ChatMember[]>();

  // RPL_WHOREPLY (352) may arrive before NAMREPLY has committed the
  // member list to the channel record — depending on the server, /WHO
  // can be processed before the post-JOIN NAMES burst. We buffer flags
  // keyed by (channelKey, lower(nick)) and apply them whenever the
  // member surface (NAMREPLY commit OR member-update push) catches up.
  private pendingAwayFlags = new Map<string, Map<string, string>>();

  // IRC server software / network identity, captured from RPL_MYINFO (004)
  // and RPL_ISUPPORT (005). Surfaced in the chat header as a small "via
  // solanum 1.0-dev · Libera.Chat" badge so users can confirm what they're
  // actually connected to.
  private serverInfo: ServerInfo = {};

  // Server-advertised channel directory. Engine does the protocol-level
  // accumulation (322 / 323) and ships us the finished list as a single
  // 'channel-directory' frame; we just store + expose it here.
  private channelDirectory: ChannelDirectory = { status: 'idle', entries: [], updatedAt: null };
  private unsubscribeChannelDirectory: (() => void) | null = null;

  // Per-(channel, nick) typing expiry timer handles. Cleared whenever the
  // typing entry is removed (explicit `+typing=done`, the typer's own
  // PRIVMSG arriving, or the timer firing). The IRCv3 spec says clients
  // SHOULD auto-clear active typers after 6s with no refresh.
  private typingTimers = new Map<string, ReturnType<typeof setTimeout>>();
  // Last time WE emitted `+typing=active` per channel, used to throttle the
  // send-side to TYPING_REFRESH_MS so we don't spam TAGMSGs on every keystroke.
  private lastTypingActive = new Map<string, number>();

  // Whether THIS server is the one the user is currently looking at in the
  // directory's server rail. Off by default — the directory bloc flips it
  // when the user picks this server. Unread bumping only suppresses for the
  // currently-foreground server's active channel; messages on any other
  // server (or any other channel within this server) still bump.
  private isForeground = false;

  // Optional persistence — when set, channel scrollback is hydrated from
  // IndexedDB (or whatever ChatHistoryStore the app wires in) on first
  // observation and mirrored on append/clear. Absent it, the service behaves
  // exactly as before: in-memory-only logs that die with the page.
  private readonly persistence: ChatPersistence | null;
  // Channels we've already requested history for during this session. Prevents
  // double-loading when ensureChannel() is called repeatedly for the same key.
  private readonly hydratedChannels = new Set<string>();
  // Rolling window of raw engine events for the dev-tools log panel. Bounded
  // by SERVER_LOG_CAP; oldest entries are evicted as new ones arrive. Held as
  // a mutable array internally; getState() returns the live reference and
  // consumers treat it as ReadonlyArray.
  private readonly serverLog: ServerLogEntry[] = [];

  constructor(
    private readonly session: ServerSession,
    private myNick: string,
    persistence?: ChatPersistence,
  ) {
    this.persistence = persistence ?? null;
  }

  attach(): void {
    if (this.unsubscribeEngine) return;
    this.unsubscribeEngine = this.session.onEvent((e) => this.handleEvent(e));
    // Engine sends a finished channel directory whenever a LIST cycle
    // completes (auto-fetched post-welcome, or on user-requested refresh).
    // We just store the result; the engine owns the 322/323 accumulation.
    this.unsubscribeChannelDirectory = this.session.onChannelDirectory((entries) => {
      this.channelDirectory = {
        status: 'ready',
        entries: entries.slice(),
        updatedAt: Date.now(),
      };
      this.emit();
    });
  }

  detach(): void {
    this.unsubscribeEngine?.();
    this.unsubscribeEngine = null;
    this.unsubscribeChannelDirectory?.();
    this.unsubscribeChannelDirectory = null;
    // Clear any pending typing-expiry timers so we don't fire emit() into a
    // detached service. The state itself is left intact in case a caller
    // re-attaches (we don't have a use case for that today, but it's cheap).
    for (const handle of this.typingTimers.values()) clearTimeout(handle);
    this.typingTimers.clear();
  }

  // Ask the engine to refresh the channel directory. The engine handles
  // the IRC-level accumulation (322 / 323) and pushes back a completed
  // list via the channel-directory event the engine client listens for.
  requestChannelList(): void {
    if (this.channelDirectory.status !== 'loading') {
      this.channelDirectory = { ...this.channelDirectory, status: 'loading' };
      this.emit();
    }
    this.session.list();
  }

  setNick(nick: string): void { this.myNick = nick; }

  // Called by DirectoryBloc when the user switches into/out of viewing this
  // server. When flipping to foreground, the currently-active channel
  // becomes "read" — clear its counters. Future messages still bump unread
  // for any non-active channel, even while foreground.
  setForeground(value: boolean): void {
    if (this.isForeground === value) return;
    this.isForeground = value;
    if (value && this.activeChannel) {
      const ch = this.channels.get(this.activeChannel);
      if (ch && (ch.unread > 0 || ch.mentions > 0)) {
        ch.unread = 0;
        ch.mentions = 0;
        this.emit();
        return;
      }
    }
    this.emit();
  }

  // Actions -----------------------------------------------------------------

  join(channel: string): void {
    const name = normaliseChannel(channel);
    if (!name) return;
    const key = this.channelKey(name);
    if (!this.channels.has(key)) {
      // Store the channel keyed by its lowercase form so subsequent server
      // events (which may use different casing) land on the same record.
      this.channels.set(key, { name: key, messages: [], joined: false, members: [], typing: [], unread: 0, mentions: 0, topic: '' });
    }
    // Auto-switch to the channel we just asked to join so the user sees it
    // immediately, even before the server's JOIN echo arrives.
    this.activeChannel = key;
    this.emit();
    this.session.join(key);
  }

  part(channel: string): void {
    this.session.part(channel);
    this.removeChannel(channel);
  }

  send(channel: string, message: string): void {
    if (!message.trim()) return;
    this.session.privmsg(channel, message);
    // Optimistic local echo — IRC doesn't reflect our own PRIVMSGs back.
    this.appendMessage(channel, {
      id: this.id(),
      kind: 'message',
      from: this.myNick,
      text: message,
      timestamp: Date.now(),
    });
  }

  // input() is the single entrypoint for the chat input box. Plain text goes
  // to the active channel; lines starting with '/' are slash commands.
  input(text: string): void {
    const trimmed = text.trim();
    if (!trimmed) return;
    if (trimmed.startsWith('/') && !trimmed.startsWith('//')) {
      this.executeCommand(trimmed);
      return;
    }
    if (!this.activeChannel) {
      this.systemHere('No active channel. Use /join #channel first.');
      return;
    }
    // Allow `//foo` as an escape for a literal leading slash.
    const payload = trimmed.startsWith('//') ? trimmed.slice(1) : trimmed;
    this.send(this.activeChannel, payload);
  }

  private executeCommand(raw: string): void {
    const spaceIdx = raw.indexOf(' ');
    const cmd = (spaceIdx < 0 ? raw : raw.slice(0, spaceIdx)).slice(1).toLowerCase();
    const args = spaceIdx < 0 ? '' : raw.slice(spaceIdx + 1).trim();

    switch (cmd) {
      case 'join':  return this.cmdJoin(args);
      case 'part':
      case 'leave': return this.cmdPart(args);
      case 'msg':
      case 'query': return this.cmdMsg(args);
      case 'me':    return this.cmdMe(args);
      case 'clear': return this.cmdClear();
      case 'help':  return this.cmdHelp();
      case 'away':  return this.cmdAway(args);
      case 'back':  return this.cmdAway('');
      default:      return this.systemHere(`Unknown command: /${cmd}. Try /help.`);
    }
  }

  private cmdAway(message: string): void {
    // Empty message ⇒ clears the away flag (i.e. /back). The engine
    // echoes RPL_NOWAWAY (306) or RPL_UNAWAY (305) back through
    // handleEvent which posts the confirmation system message.
    this.session.away(message);
  }

  private cmdJoin(args: string): void {
    const channel = args.split(/\s+/)[0];
    if (!channel) return this.systemHere('Usage: /join <channel>');
    this.join(channel);
  }

  private cmdPart(args: string): void {
    const target = args.split(/\s+/)[0] || this.activeChannel;
    if (!target) return this.systemHere('Usage: /part [channel]');
    this.part(target);
  }

  private cmdMsg(args: string): void {
    const spaceIdx = args.indexOf(' ');
    // `/msg <nick>` (no message) — just open the DM tab, don't send.
    // `/msg <nick> <message>` — open + send.
    const target = (spaceIdx <= 0 ? args : args.slice(0, spaceIdx)).trim();
    const message = spaceIdx <= 0 ? '' : args.slice(spaceIdx + 1).trim();
    if (!target) return this.systemHere('Usage: /msg <nick> [message]');
    this.openDM(target);
    if (message) this.send(target, message);
  }

  // Open a DM tab with `nick`. Creates the channel record if it doesn't
  // exist yet, marks it active so the chat area swaps to it. Exposed so
  // the right-click nick context menu can call it directly instead of
  // routing through the /msg slash command (which used to require a
  // message body, making "Send message" a no-op).
  openDM(nick: string): void {
    const target = nick.trim();
    if (!target) return;
    const key = this.channelKey(target);
    if (!this.channels.has(key)) {
      this.channels.set(key, {
        name: target,
        messages: [],
        joined: false,
        members: [],
        typing: [],
        unread: 0,
        mentions: 0,
        topic: '',
      });
    }
    this.activeChannel = key;
    this.emit();
  }

  private cmdMe(args: string): void {
    if (!this.activeChannel) return this.systemHere('Use /me inside a channel.');
    if (!args.trim()) return this.systemHere('Usage: /me <action>');
    // CTCP ACTION: PRIVMSG body wrapped in \x01ACTION ...\x01
    const wrapped = `ACTION ${args}`;
    this.session.privmsg(this.activeChannel, wrapped);
    this.appendMessage(this.activeChannel, {
      id: this.id(),
      kind: 'action',
      from: this.myNick,
      text: args,
      timestamp: Date.now(),
    });
  }

  private cmdClear(): void {
    if (!this.activeChannel) return;
    const ch = this.channels.get(this.activeChannel);
    if (ch) {
      ch.messages = [];
      this.emit();
    }
    // Persisted history goes with the in-memory log; otherwise a /clear would
    // un-clear itself the next time the user reopens the channel.
    if (this.persistence) {
      const { history, scope } = this.persistence;
      void history
        .clear({ userId: scope.userId, serverId: scope.serverId, channel: this.activeChannel })
        .catch(() => {
          // Best-effort. Worst case the user sees old messages on reload.
        });
    }
  }

  private cmdHelp(): void {
    this.emitFeedback({ kind: 'help', commands: SLASH_COMMANDS });
  }

  // Surface command feedback to the UI via the feedback channel. Errors
  // become a transient banner above the input; never pollute the chat log.
  private systemHere(text: string): void {
    this.emitFeedback({ kind: 'error', text });
  }

  setActive(channel: string | null): void {
    const key = channel == null ? null : this.channelKey(channel);
    if (this.activeChannel === key) return;
    this.activeChannel = key;
    // Switching INTO a channel marks it read — but only when this server is
    // also currently being viewed. Otherwise the user just preselected the
    // channel for next time they switch into the server, and shouldn't
    // forfeit existing notifications.
    if (key && this.isForeground) {
      const ch = this.channels.get(key);
      if (ch && (ch.unread > 0 || ch.mentions > 0)) {
        ch.unread = 0;
        ch.mentions = 0;
      }
    }
    this.emit();
    // If the channel was joined but its NAMES haven't populated, ask the
    // engine to re-request — covers cases where the initial NAMREPLY was
    // lost (WS buffer pressure, engine restart, etc.).
    if (key) this.maybeRefreshNames(key);
  }

  // Bump unread + mention counts for an incoming message in `channel`.
  // No-op when the message is from us, or when this server is foregrounded
  // AND the channel matches the active one (the user is literally watching
  // it). Mentions = subset where another user said our own nick — OR, for
  // DM channels (anything that doesn't start with # or &), every message
  // is a mention because the channel itself represents a 1:1 conversation
  // and is inherently directed at us.
  //
  // Note: ensures the channel record exists before reading it. The PRIVMSG
  // handler calls bumpUnread BEFORE appendMessage (which is what would
  // otherwise create the channel), so a DM from a brand-new sender would
  // silently no-op without this guard.
  private bumpUnread(channel: string, from: string, text: string): void {
    if (from === this.myNick) return;
    const key = this.channelKey(channel);
    // Service / server log channel never bumps — it's informational, and the
    // whole point of routing service NOTICEs there is to keep them quiet.
    if (key === SERVICE_CHANNEL) {
      this.ensureChannel(channel);
      return;
    }
    if (this.isForeground && this.activeChannel === key) return;
    const ch = this.ensureChannel(channel);
    ch.unread += 1;
    const isDM = !key.startsWith('#') && !key.startsWith('&');
    if (isDM || containsNickMention(text, this.myNick)) ch.mentions += 1;
  }

  // Send NAMES <channel> if the channel has < 1 member and we haven't asked
  // recently. Throttled to one request per channel per RENAME_THROTTLE_MS.
  private static readonly NAMES_THROTTLE_MS = 5000;
  private namesRequestedAt = new Map<string, number>();
  private maybeRefreshNames(channel: string): void {
    const key = this.channelKey(channel);
    const ch = this.channels.get(key);
    if (!ch || !ch.joined) return;
    if (ch.members.length > 0) return;
    const last = this.namesRequestedAt.get(key) ?? 0;
    if (Date.now() - last < ChatService.NAMES_THROTTLE_MS) return;
    this.namesRequestedAt.set(key, Date.now());
    this.session.names(key);
  }

  // Channel names in IRC are case-insensitive per CASEMAPPING. We normalize
  // to lowercase for lookups so server-canonicalized casing (e.g. "#General"
  // vs the "#general" the user typed) lands on the same record. DM virtual
  // channels (keyed by nick) preserve case — nick equality is exact.
  private channelKey(target: string): string {
    if (target.startsWith('#') || target.startsWith('&')) return target.toLowerCase();
    return target;
  }

  // Apply a (lower-nick → WHO-flags) map to a channel's members in place.
  // Returns true if any member's awayMessage changed. Used both when a
  // 352 arrives after the member list is already committed, and when 366
  // commits the member list with 352s buffered ahead of it.
  private applyAwayFlags(ch: ChatChannel, flags: Map<string, string>): boolean {
    let touched = false;
    for (const m of ch.members) {
      const f = flags.get(m.nick.toLowerCase());
      if (f === undefined) continue;
      const isAway = f.startsWith('G');
      const next = isAway ? (m.awayMessage ?? '') : null;
      if (m.awayMessage !== next) {
        m.awayMessage = next;
        touched = true;
      }
    }
    return touched;
  }

  // Observation -------------------------------------------------------------

  getState(): ChatState {
    return {
      channels: Array.from(this.channels.values()).map((c) => ({
        ...c,
        messages: [...c.messages],
      })),
      activeChannel: this.activeChannel,
      // Hand back a fresh shallow copy so subscribers that retain old
      // snapshots don't see the buffer mutate underneath them when the next
      // event lands.
      serverLog: this.serverLog.slice(),
      serverInfo: { ...this.serverInfo },
      channelDirectory: {
        status: this.channelDirectory.status,
        entries: this.channelDirectory.entries.slice(),
        updatedAt: this.channelDirectory.updatedAt,
      },
    };
  }

  // Empty the captured server-log buffer and notify subscribers. Used by the
  // "Clear" button in the dev-tools log panel — every other consumer treats
  // the buffer as append-only.
  clearServerLog(): void {
    if (this.serverLog.length === 0) return;
    this.serverLog.length = 0;
    this.emit();
  }

  subscribe(fn: ChatListener): () => void {
    this.listeners.add(fn);
    fn(this.getState());
    return () => { this.listeners.delete(fn); };
  }

  // Out-of-band channel for slash-command UI signaling. UI surfaces errors as
  // a transient banner and help as a modal — neither belongs in the chat log.
  onFeedback(fn: ChatFeedbackListener): () => void {
    this.feedbackListeners.add(fn);
    return () => { this.feedbackListeners.delete(fn); };
  }

  private emitFeedback(f: ChatFeedback): void {
    this.feedbackListeners.forEach((fn) => fn(f));
  }

  // Subscribe to self-membership transitions (join / part / kick) for THIS
  // user. Used by DirectoryBloc to update the persisted channel set only on
  // real events — never on transient chat-state emits. Returns an unsubscribe.
  onSelfMembership(fn: SelfMembershipListener): () => void {
    this.membershipListeners.add(fn);
    return () => { this.membershipListeners.delete(fn); };
  }

  private emitSelfMembership(event: SelfMembershipEvent): void {
    this.membershipListeners.forEach((fn) => {
      try { fn(event); } catch { /* isolate listener errors */ }
    });
  }

  // Engine event dispatch ---------------------------------------------------

  private handleEvent(e: IrcEvent): void {
    // Capture EVERY event to the dev-tools log before kind-specific routing.
    // This is intentionally noisy — the panel exists so users / devs can see
    // exactly what the engine is forwarding during connect (NOTICE / 001 /
    // MOTD / ISUPPORT) and during normal operation.
    this.appendServerLog({
      id: this.id(),
      kind: e.Kind,
      from: e.From,
      target: e.Target ?? '',
      message: e.Message ?? '',
      timestamp: Date.now(),
    });
    switch (e.Kind) {
      case 'PRIVMSG':
      case 'NOTICE': {
        if (!e.Target) return;
        const t = e.Target;
        const isToMe = t === this.myNick;
        const isChannel = t.startsWith('#') || t.startsWith('&');
        const isWildcard = isServerWildcardTarget(t);
        // Drop anything that isn't a channel, addressed to us, or a known
        // pre-registration server target (*, AUTH). Those slip through to
        // the dev-tools server log via appendServerLog above, which is
        // the right home for genuine wire noise.
        if (!isToMe && !isChannel && !isWildcard) return;
        // Decide which UI channel this message belongs in:
        //   - real channel (#foo): keep the original target
        //   - DM from a service (NickServ, server-source): pseudo `~server`
        //   - DM from a real user: virtual channel keyed by the sender
        //   - pre-reg server notice (target=*): pseudo `~server`
        const channel = isChannel
          ? t
          : (isServiceSender(e.From) || isWildcard ? SERVICE_CHANNEL : e.From);
        let kind: ChatMessageKind = e.Kind === 'NOTICE' ? 'notice' : 'message';
        let text = e.Message;
        // Anyone sending a message is, by definition, active right now.
        this.touchMemberActivity(e.From, Date.now());
        // A real message implicitly cancels any pending `+typing=active` for
        // that nick in this channel.
        this.clearTyping(channel, e.From);
        // Detect CTCP ACTION (\x01ACTION ...\x01) — render as 'action' kind.
        if (kind === 'message' && text.startsWith('ACTION ') && text.endsWith('')) {
          text = text.slice('ACTION '.length, -1);
          kind = 'action';
        }
        // Bump unread counters BEFORE appendMessage — appendMessage emits to
        // subscribers, and we want them to see the fresh counter state in
        // the same render cycle. Otherwise the badge lags by one message.
        this.bumpUnread(channel, e.From, text);
        this.appendMessage(channel, {
          id: this.id(),
          kind,
          from: e.From,
          text,
          timestamp: Date.now(),
        });
        break;
      }
      case 'JOIN': {
        if (!e.Target) return;
        const key = this.channelKey(e.Target);
        if (e.From === this.myNick) {
          // We just joined a channel. Fire the self-membership event so the
          // persistence layer can add this channel to the saved set — even
          // if the channel record already existed locally (idempotent).
          this.ensureChannel(e.Target, true);
          this.emitSelfMembership({ kind: 'join', channel: key });
          this.appendSystem(e.Target, `You joined ${e.Target}`);
          if (!this.activeChannel) this.setActive(e.Target);
          // Safety net: if NAMREPLY/ENDOFNAMES never arrive (e.g. drop on
          // the WS), this re-issues NAMES after a short delay.
          setTimeout(() => this.maybeRefreshNames(key), 2500);
        } else {
          // Track the joiner in the channel's member list (no prefix sigil yet).
          const ch = this.channels.get(key);
          if (ch && !ch.members.some((m) => m.nick === e.From)) {
            ch.members = [...ch.members, { nick: e.From, prefix: '', joinedAt: Date.now() }];
          }
          this.appendMessage(e.Target, {
            id: this.id(),
            kind: 'join',
            from: e.From,
            text: `${e.From} joined`,
            timestamp: Date.now(),
          });
        }
        break;
      }
      case 'PART': {
        if (!e.Target) return;
        const key = this.channelKey(e.Target);
        if (e.From === this.myNick) {
          this.removeChannel(e.Target);
          this.emitSelfMembership({ kind: 'part', channel: key });
        } else {
          const ch = this.channels.get(key);
          if (ch) ch.members = ch.members.filter((m) => m.nick !== e.From);
          this.appendMessage(e.Target, {
            id: this.id(),
            kind: 'part',
            from: e.From,
            text: `${e.From} left`,
            timestamp: Date.now(),
          });
        }
        break;
      }
      case 'KICK': {
        if (!e.Target) return;
        const kicked = e.Args?.[0];
        if (!kicked) break;
        const key = this.channelKey(e.Target);
        if (kicked === this.myNick) {
          // We were the one kicked — drop the channel entirely.
          this.removeChannel(e.Target);
          this.emitSelfMembership({ kind: 'kick', channel: key });
        } else {
          const ch = this.channels.get(key);
          if (ch) ch.members = ch.members.filter((m) => m.nick !== kicked);
          this.appendMessage(e.Target, {
            id: this.id(),
            kind: 'kick',
            from: e.From,
            text: `${e.From} kicked ${kicked}${e.Message ? ` (${e.Message})` : ''}`,
            timestamp: Date.now(),
          });
        }
        break;
      }
      case 'MODE': {
        if (!e.Target) return;
        if (!e.Target.startsWith('#') && !e.Target.startsWith('&')) break; // ignore user-mode events
        const args = e.Args ?? [];
        if (args.length === 0) break;
        this.applyChannelMode(e.Target, args[0]!, args.slice(1));
        this.appendMessage(e.Target, {
          id: this.id(),
          kind: 'system',
          from: '',
          text: `${e.From || 'server'} sets mode ${args.join(' ')}`,
          timestamp: Date.now(),
        });
        break;
      }
      case 'QUIT':
        // Quits aren't channel-scoped — IRC sends one QUIT, we just record it system-style on every channel.
        this.channels.forEach((c) => {
          c.members = c.members.filter((m) => m.nick !== e.From);
          const quitMsg: ChatMessage = {
            id: this.id(),
            kind: 'quit',
            from: e.From,
            text: `${e.From} quit${e.Message ? ` (${e.Message})` : ''}`,
            timestamp: Date.now(),
          };
          c.messages.push(quitMsg);
          // Mirror QUIT into persistence too — historically the only kind of
          // message that bypassed appendMessage(). Keeps cross-channel quits
          // intact across restart.
          if (this.persistence) {
            const { history, scope } = this.persistence;
            void history
              .append({ userId: scope.userId, serverId: scope.serverId, channel: c.name }, quitMsg)
              .catch(() => {});
          }
        });
        this.emit();
        break;
      case 'NICK': {
        // :oldnick NICK newnick — rename across every channel's member list.
        const newNick = e.Message;
        if (!newNick) break;
        this.channels.forEach((c) => {
          c.members = c.members.map((m) => (m.nick === e.From ? { ...m, nick: newNick } : m));
        });
        if (e.From === this.myNick) this.myNick = newNick;
        this.emit();
        break;
      }
      case '353': {
        // RPL_NAMREPLY — accumulate; ENDOFNAMES commits.
        if (!e.Target) return;
        const key = this.channelKey(e.Target);
        const tokens = (e.Message ?? '').split(/\s+/).filter(Boolean);
        const parsed = tokens.map(parseMemberToken);
        const existing = this.pendingMembers.get(key) ?? [];
        this.pendingMembers.set(key, [...existing, ...parsed]);
        break;
      }
      case '366': {
        // RPL_ENDOFNAMES — commit pending names into the channel, then
        // drain any RPL_WHOREPLY flags that arrived early.
        if (!e.Target) return;
        const key = this.channelKey(e.Target);
        const pending = this.pendingMembers.get(key) ?? [];
        this.pendingMembers.delete(key);
        const ch = this.channels.get(key);
        if (ch) {
          ch.members = dedupeMembers(pending);
          const pendingFlags = this.pendingAwayFlags.get(key);
          if (pendingFlags && pendingFlags.size > 0) {
            this.applyAwayFlags(ch, pendingFlags);
          }
          this.emit();
        }
        break;
      }
      case 'TOPIC':
      case '332': {
        // Live TOPIC change (anyone in the channel) OR RPL_TOPIC (332) the
        // server sends on JOIN. Both carry the new topic in Message and
        // the channel name in Target. TOPIC also has the setter in From;
        // 332 doesn't (the server is "setting" it for us at join time).
        if (!e.Target) return;
        const ch = this.ensureChannel(e.Target);
        ch.topic = e.Message ?? '';
        if (e.Kind === 'TOPIC' && e.From) {
          ch.topicSetBy = e.From;
          ch.topicSetAt = Date.now();
          // Surface the change inline so users see who edited it without
          // having to look up to the header. Empty string = topic cleared.
          const note = e.Message
            ? `${e.From} changed the topic to: ${e.Message}`
            : `${e.From} cleared the topic`;
          ch.messages = [
            ...ch.messages,
            { id: crypto.randomUUID(), kind: 'system', from: '', text: note, timestamp: Date.now() },
          ];
        }
        this.emit();
        break;
      }
      case '331': {
        // RPL_NOTOPIC — server confirms no topic on JOIN.
        if (!e.Target) return;
        const ch = this.ensureChannel(e.Target);
        ch.topic = '';
        ch.topicSetBy = undefined;
        ch.topicSetAt = undefined;
        this.emit();
        break;
      }
      case '333': {
        // RPL_TOPICWHOTIME — Args = [setter-nick, unix-timestamp]. Some
        // servers omit this; we treat it as best-effort metadata.
        if (!e.Target) return;
        const args = e.Args ?? [];
        if (args.length < 2) return;
        const ch = this.ensureChannel(e.Target);
        ch.topicSetBy = args[0];
        const epoch = Number.parseInt(args[1] ?? '', 10);
        if (Number.isFinite(epoch)) ch.topicSetAt = epoch * 1000;
        this.emit();
        break;
      }
      case 'AWAY': {
        // IRCv3 away-notify push for ANY user in a shared channel.
        // From = nick, Message = away reason ("" when they came back).
        // Update awayMessage on every ChatMember record matching that
        // nick across every channel we share with them.
        if (!e.From) return;
        const message = e.Message ?? '';
        let touched = false;
        for (const ch of this.channels.values()) {
          for (const m of ch.members) {
            if (m.nick !== e.From) continue;
            m.awayMessage = message === '' ? null : message;
            touched = true;
          }
        }
        if (touched) this.emit();
        break;
      }
      case '301': {
        // RPL_AWAY — server reply when we PRIVMSG an away user.
        // Args[0] = target nick, Message = their away message.
        const args = e.Args ?? [];
        const nick = args[0];
        if (!nick) return;
        let touched = false;
        for (const ch of this.channels.values()) {
          for (const m of ch.members) {
            if (m.nick !== nick) continue;
            m.awayMessage = e.Message ?? '';
            touched = true;
          }
        }
        if (touched) this.emit();
        break;
      }
      case '352': {
        // RPL_WHOREPLY — one line per channel member after we /WHO a
        // channel on join. The engine forwards Target = channel,
        // From = nick, Args = [statusFlags]. Flags begin with H (here)
        // or G (gone/away), followed by optional sigils.
        //
        // Two timing realities to handle:
        //   1. NAMREPLY already arrived → apply immediately to the
        //      member record (case-insensitive nick compare; servers
        //      can normalise casing differently between NAMES and WHO).
        //   2. NAMREPLY hasn't committed yet → stash the flag in
        //      pendingAwayFlags so 366 picks it up.
        if (!e.Target || !e.From) return;
        const key = this.channelKey(e.Target);
        const flags = (e.Args ?? [])[0] ?? '';
        const nickLower = e.From.toLowerCase();
        const pending = this.pendingAwayFlags.get(key) ?? new Map<string, string>();
        pending.set(nickLower, flags);
        this.pendingAwayFlags.set(key, pending);
        const ch = this.channels.get(key);
        if (ch && ch.members.length > 0) {
          if (this.applyAwayFlags(ch, pending)) this.emit();
        }
        break;
      }
      case '306':
      case '305': {
        // Self-acks. 306 = "you are away", 305 = "you are back".
        // Surface as a system message in the active channel so the user
        // sees confirmation — no member-record mutation since we don't
        // necessarily appear in our own channel member list yet at this
        // point in the handshake.
        if (!this.activeChannel) break;
        const ch = this.channels.get(this.activeChannel);
        if (!ch) break;
        const text = e.Kind === '306' ? 'You are now marked as away.' : 'You are no longer marked as away.';
        ch.messages = [
          ...ch.messages,
          { id: crypto.randomUUID(), kind: 'system', from: '', text, timestamp: Date.now() },
        ];
        this.emit();
        break;
      }
      case '004': {
        // RPL_MYINFO — engine forwards Args = [serverName, version].
        const args = e.Args ?? [];
        const next: ServerInfo = { ...this.serverInfo };
        if (args[0]) next.serverName = args[0];
        if (args[1]) next.version = args[1];
        this.serverInfo = next;
        this.emit();
        break;
      }
      case 'CAP': {
        // CAP <target> <subcommand> [...args] [:trailing]. Engine forwards
        // Args = [subcommand, ...rest] and Message = trailing list.
        const args = e.Args ?? [];
        const sub = args[0];
        if (sub !== 'ACK') break;
        // The cap list lives in the trailing parameter when present, otherwise
        // in the remaining args. Solanum/Libera always send it as trailing.
        const raw = e.Message && e.Message.length > 0 ? e.Message : args.slice(1).join(' ');
        const caps = raw.split(/\s+/).map((s) => s.trim()).filter(Boolean);
        if (caps.length === 0) break;
        const existing = new Set(this.serverInfo.enabledCaps ?? []);
        let changed = false;
        for (const c of caps) { if (!existing.has(c)) { existing.add(c); changed = true; } }
        if (changed) {
          this.serverInfo = { ...this.serverInfo, enabledCaps: Array.from(existing).sort() };
          this.emit();
        }
        break;
      }
      case '005': {
        // RPL_ISUPPORT — scan tokens for NETWORK=<name>. There can be many
        // 005 lines; we only update if we actually find something new.
        const args = e.Args ?? [];
        for (const tok of args) {
          const eq = tok.indexOf('=');
          if (eq === -1) continue;
          const key = tok.slice(0, eq);
          const value = tok.slice(eq + 1);
          if (key === 'NETWORK' && value && this.serverInfo.network !== value) {
            this.serverInfo = { ...this.serverInfo, network: value };
            this.emit();
          }
        }
        break;
      }
      case 'TAGMSG': {
        // IRCv3 client-tag carrier. Today we only care about `+typing`.
        // Channel or DM target lives in e.Target; nick that's typing is e.From.
        // We ignore our own echoes (servers with `echo-message` send them back).
        if (!e.Target || !e.From || e.From === this.myNick) break;
        const tags = e.Tags ?? {};
        const typing = tags['+typing'];
        if (!typing) break;
        const channel = e.Target === this.myNick ? e.From : e.Target;
        if (typing === 'active') {
          this.markTyping(channel, e.From);
        } else {
          // `done` and `paused` both clear the typer immediately. Anything
          // else (future tag values) is treated as a stop too.
          this.clearTyping(channel, e.From);
        }
        break;
      }
      default:
        // Welcome/MOTD/etc. ignored at chat layer (engine status panel handles them).
        break;
    }
  }

  // Public: emit a `+typing=active|done` TAGMSG for the active channel.
  // Callers (the chat input) should call sendTyping(channel, 'active') on
  // each keystroke; this method throttles internally so we don't flood the
  // wire. Calling with 'done' always fires (no throttle) so a Send / clear
  // tells everyone we stopped immediately.
  sendTyping(channel: string, state: 'active' | 'done'): void {
    if (!channel) return;
    const key = this.channelKey(channel);
    if (state === 'active') {
      const last = this.lastTypingActive.get(key) ?? 0;
      const now = Date.now();
      if (now - last < TYPING_REFRESH_MS) return;
      this.lastTypingActive.set(key, now);
    } else {
      this.lastTypingActive.delete(key);
    }
    this.session.tagmsg(channel, { '+typing': state });
  }

  // --- typing-state helpers (private) -------------------------------------

  private typingKey(channel: string, nick: string): string {
    return `${this.channelKey(channel)}|${nick}`;
  }

  private markTyping(channel: string, nick: string): void {
    const key = this.channelKey(channel);
    const ch = this.channels.get(key);
    if (!ch) return;
    if (!ch.typing.includes(nick)) {
      ch.typing = [...ch.typing, nick];
    }
    // Reset / start the 6s expiry timer; an `active` refresh extends it.
    const tk = this.typingKey(channel, nick);
    const existing = this.typingTimers.get(tk);
    if (existing) clearTimeout(existing);
    const handle = setTimeout(() => this.clearTyping(channel, nick), TYPING_EXPIRY_MS);
    this.typingTimers.set(tk, handle);
    this.emit();
  }

  private clearTyping(channel: string, nick: string): void {
    const key = this.channelKey(channel);
    const tk = this.typingKey(channel, nick);
    const existing = this.typingTimers.get(tk);
    if (existing) {
      clearTimeout(existing);
      this.typingTimers.delete(tk);
    }
    const ch = this.channels.get(key);
    if (!ch) return;
    if (!ch.typing.includes(nick)) return;
    ch.typing = ch.typing.filter((n) => n !== nick);
    this.emit();
  }

  // Helpers -----------------------------------------------------------------

  private ensureChannel(name: string, joined = false): ChatChannel {
    const key = this.channelKey(name);
    let ch = this.channels.get(key);
    if (!ch) {
      ch = { name: key, messages: [], joined, members: [], typing: [], unread: 0, mentions: 0, topic: '' };
      this.channels.set(key, ch);
    } else if (joined) {
      ch.joined = true;
    }
    // Lazy-hydrate from persistence on first observation. Fire-and-forget so
    // we don't block the event loop or callers — the listeners will see the
    // hydrated messages once the load promise resolves.
    this.hydrateFromHistory(key);
    this.emit();
    return ch;
  }

  // Pull persisted messages for this channel from the configured history
  // store and prepend them to the in-memory log, deduping by id. Runs at most
  // once per channel per session; if persistence isn't configured this is a
  // no-op. Errors are swallowed — chat must keep working if storage hiccups.
  private hydrateFromHistory(key: string): void {
    if (!this.persistence) return;
    if (this.hydratedChannels.has(key)) return;
    this.hydratedChannels.add(key);
    const { history, scope } = this.persistence;
    void history
      .load({ userId: scope.userId, serverId: scope.serverId, channel: key })
      .then((persisted) => {
        if (persisted.length === 0) return;
        const ch = this.channels.get(key);
        if (!ch) return;
        // Rewrite each persisted message's id to a guaranteed-unique value
        // before merging. Older sessions wrote ids like "1", "2", ... so the
        // store can hold many rows that share an id — using them as React
        // keys triggers "two or more children with the same key" warnings
        // and render glitches. We only need the original id for the dedup
        // pass against in-memory messages; after that it's safe to discard.
        const seen = new Set(ch.messages.map((m) => m.id));
        const prepend = persisted
          .filter((m) => !seen.has(m.id))
          .map((m, i) => ({ ...m, id: `${this.idSalt}-h${i}` }));
        if (prepend.length === 0) return;
        // Persisted messages predate anything that arrived during this session
        // for this channel, so they go first.
        ch.messages = [...prepend, ...ch.messages];
        this.emit();
      })
      .catch(() => {
        // Hydration failed (IDB error, parse problem, etc.) — leave the
        // hydrated flag set so we don't spin. The user simply sees the
        // session's own messages, which is the legacy behaviour.
      });
  }

  private removeChannel(name: string): void {
    const key = this.channelKey(name);
    if (this.channels.delete(key)) {
      // Drop the hydration marker so that if the user rejoins later, we'll
      // pull fresh history from the store. Without this, leaving + rejoining
      // in the same session would skip persisted scrollback.
      this.hydratedChannels.delete(key);
      if (this.activeChannel === key) {
        this.activeChannel = this.channels.size > 0 ? this.channels.keys().next().value! : null;
      }
      this.emit();
    }
  }

  private appendMessage(channel: string, msg: ChatMessage): void {
    const ch = this.ensureChannel(channel);
    ch.messages.push(msg);
    this.emit();
    // Mirror to persistence (fire-and-forget). The store enforces its own cap
    // so callers don't need to think about eviction.
    if (this.persistence) {
      const { history, scope } = this.persistence;
      const key = this.channelKey(channel);
      void history
        .append({ userId: scope.userId, serverId: scope.serverId, channel: key }, msg)
        .catch(() => {
          // Storage hiccup — chat keeps going with in-memory state.
        });
    }
  }

  // Apply a MODE command to the channel: update member prefix sigils for
  // user-status modes (~/&/@/%/+). Other modes (i, m, k, l, b, e, I…) are
  // consumed for argument tracking but ignored otherwise. A definitive
  // re-sync should still come from a periodic NAMES refresh.
  private applyChannelMode(channel: string, modeStr: string, params: string[]): void {
    const key = this.channelKey(channel);
    const ch = this.channels.get(key);
    if (!ch) return;
    const PREFIX_OF: Record<string, MemberPrefix> = {
      q: '~', a: '&', o: '@', h: '%', v: '+',
    };
    // Modes that take an argument when added (most also do on removal).
    const TAKES_ARG = new Set(['o', 'v', 'h', 'q', 'a', 'k', 'b', 'e', 'I']);
    let adding = true;
    let argIdx = 0;
    let nextMembers = ch.members;
    for (const ch_ of modeStr) {
      if (ch_ === '+') { adding = true; continue; }
      if (ch_ === '-') { adding = false; continue; }
      const sigil = PREFIX_OF[ch_];
      if (sigil) {
        const nick = params[argIdx++];
        if (!nick) continue;
        nextMembers = nextMembers.map((m) => {
          if (m.nick !== nick) return m;
          if (adding) {
            // Promote if equal-or-higher rank than current.
            if (prefixRank(sigil) <= prefixRank(m.prefix)) return m;
            return { ...m, prefix: sigil };
          }
          // Removal: drop the prefix only if it's currently set to exactly this sigil.
          if (m.prefix === sigil) return { ...m, prefix: '' };
          return m;
        });
      } else if (TAKES_ARG.has(ch_)) {
        // +l takes arg, -l doesn't, but treating as "takes arg" only on `+`
        // is a defensible heuristic; we just need to advance the cursor.
        if (adding || ch_ !== 'l') argIdx++;
      }
    }
    if (nextMembers !== ch.members) {
      ch.members = nextMembers;
      this.emit();
    }
  }

  private appendSystem(channel: string, text: string): void {
    this.appendMessage(channel, {
      id: this.id(),
      kind: 'system',
      from: '',
      text,
      timestamp: Date.now(),
    });
  }

  // Bump lastActiveAt for `nick` across every channel they're tracked in.
  // Member data is denormalized per-channel; one event updates them all.
  private touchMemberActivity(nick: string, when: number): void {
    if (!nick) return;
    let changed = false;
    this.channels.forEach((c) => {
      c.members = c.members.map((m) => {
        if (m.nick !== nick) return m;
        changed = true;
        return { ...m, lastActiveAt: when };
      });
    });
    if (changed) this.emit();
  }

  // Push one entry into the rolling server log, evicting oldest entries to
  // stay within SERVER_LOG_CAP. Does not call emit() itself — callers append
  // before the existing handleEvent() switch, which already emits via the
  // various per-kind branches. Server lines that don't hit a chat branch
  // (MOTD, ISUPPORT, etc.) still surface in the log via the next chat-level
  // emit; for the very first events at connect time the log panel itself
  // subscribes to ChatService, so a manual emit at the top of every event
  // would just duplicate the work. We do emit explicitly for the no-op kinds
  // so the panel updates in real time during the handshake.
  private appendServerLog(entry: ServerLogEntry): void {
    this.serverLog.push(entry);
    if (this.serverLog.length > SERVER_LOG_CAP) {
      // FIFO eviction. splice mutates in place — cheap for 200-cap buffers.
      this.serverLog.splice(0, this.serverLog.length - SERVER_LOG_CAP);
    }
    // Emit so the log panel updates immediately, even for engine events the
    // chat switch ignores (RPL_WELCOME, MOTD chunks, ISUPPORT, etc.).
    this.emit();
  }

  private emit(): void {
    const state = this.getState();
    this.listeners.forEach((fn) => fn(state));
  }

  private id(): string {
    return `${this.idSalt}-${this.nextId++}`;
  }
}

// Random 6-char salt for ChatService message ids. We don't need cryptographic
// uniqueness — just enough entropy that fresh ids can't collide with persisted
// ids from a previous session in the same channel.
function makeIdSalt(): string {
  return Math.random().toString(36).slice(2, 8);
}

function normaliseChannel(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return '';
  return trimmed.startsWith('#') || trimmed.startsWith('&') ? trimmed : `#${trimmed}`;
}

// Sigils in priority order — highest-rank first. When a server lists multiple
// (e.g. multi-prefix CAP gives `~@nick`), we keep the first and skip the rest.
const PREFIX_SIGILS = new Set(['~', '&', '@', '%', '+']);

function parseMemberToken(token: string): ChatMember {
  let prefix: MemberPrefix = '';
  let rest = token;
  // Take the first sigil; eat any trailing sigils so we land on the nick.
  while (rest.length > 0 && PREFIX_SIGILS.has(rest.charAt(0))) {
    if (!prefix) prefix = rest.charAt(0) as MemberPrefix;
    rest = rest.slice(1);
  }
  // userhost-in-names format: `nick!user@host` — split off and capture host.
  const bangIdx = rest.indexOf('!');
  if (bangIdx > 0) {
    const nick = rest.slice(0, bangIdx);
    const userhost = rest.slice(bangIdx + 1);
    const atIdx = userhost.indexOf('@');
    const hostname = atIdx > 0 ? userhost.slice(atIdx + 1) : undefined;
    return hostname ? { nick, prefix, hostname } : { nick, prefix };
  }
  return { nick: rest, prefix };
}

function dedupeMembers(members: ChatMember[]): ChatMember[] {
  const seen = new Map<string, ChatMember>();
  for (const m of members) {
    // Last write wins so a more-recent NAMREPLY chunk can re-state a member's prefix.
    seen.set(m.nick, m);
  }
  return Array.from(seen.values());
}

// Rank used by MODE handler to decide whether a new +mode actually promotes
// a member (e.g. don't drop an op back to voice when +v fires while they're
// still +o). Higher number = senior status.
function prefixRank(p: MemberPrefix): number {
  switch (p) {
    case '~': return 5;
    case '&': return 4;
    case '@': return 3;
    case '%': return 2;
    case '+': return 1;
    default:  return 0;
  }
}

// Kind is exported for tests.
export type { ChatMessageKind };
