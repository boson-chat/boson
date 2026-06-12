import type { IrcEvent, ServerSession } from '../engine';
import type { ChatHistoryStore } from '../history';
import { containsNickMention } from './mention';
import {
  SERVICE_CHANNEL,
  classifyNickServReply,
  isMemoServSender,
  isNickServSender,
  isServerWildcardTarget,
  isServiceSender,
  nickServReplyToStatus,
} from './services';
import { getServiceCredentialsStore, type AccountStatus } from './services-credentials';
import { getAdapter } from './adapters';
import { AnopeAccountService } from './account-service-anope';
import { AthemeAccountService } from './account-service-atheme';
import { ErgoAccountService } from './account-service-ergo';
import type { DropResult, IdentifyResult, RegisterResult, ConfirmResult, ResendResult, UnsupportedResult, AccountInfo } from './account-service';
import type { NickClaimCreateResponse, NickClaimPollResponse } from '../directory/directory.types';

// NickClaimAPI is the subset of DirectoryService methods ChatService
// needs for the automated "claim this nick" flow. Injecting via an
// interface keeps the wiring testable (no real fetch in unit tests)
// and ChatService independent of the larger DirectoryService surface.
export interface NickClaimAPI {
  createNickClaim(input: { serverId: string; accountNick: string }): Promise<NickClaimCreateResponse>;
  getNickClaim(id: string): Promise<NickClaimPollResponse>;
}

// ClaimResult is what claimNick() resolves to. Discrete kinds so the
// caller can render precise UI without parsing strings.
//
//   claimed         — full happy path; nick is identified server-side.
//   nick-taken      — REGISTER bounced because the nick is already
//                     registered; user should pick a different one.
//   expired         — backend's 30-min TTL elapsed before the code
//                     arrived (or before our poll caught it). Caller
//                     can retry from scratch.
//   cancelled       — caller aborted via the supplied AbortSignal.
//   unavailable     — backend rejected the create (rate-limit, no
//                     auth, network unreachable). Caller should fall
//                     back to the manual register+confirm form.
//   failed          — anything else with a free-form reason string.
export type ClaimResult =
  | { kind: 'claimed' }
  | { kind: 'nick-taken' }
  | { kind: 'expired' }
  | { kind: 'cancelled' }
  | { kind: 'unavailable'; reason: string }
  | { kind: 'failed'; reason: string };

// Result of resumePendingConfirmation — finishing a CONFIRM for a
// nick that's registered-but-unconfirmed and has a captured code
// waiting in the backend claim.
//   confirmed     — code found + CONFIRM accepted; account is live.
//   still-pending — the backend hasn't captured a code yet (POP3
//                   lag); the panel keeps the manual paste/resend UI.
//   wrong-code    — the captured code was rejected (parser drift).
//   expired       — the claim TTL'd out before a code was captured.
//   unavailable   — nothing to resume (no backend, no pending claim).
//   failed        — anything else, with a free-form reason.
export type ResumeConfirmResult =
  | { kind: 'confirmed' }
  | { kind: 'still-pending' }
  | { kind: 'wrong-code' }
  | { kind: 'expired' }
  | { kind: 'unavailable'; reason: string }
  | { kind: 'failed'; reason: string };
import {
  getMemoStore,
  type MemoKind,
  parseNewMemoCount,
  isNoMemos,
  parseListEntry,
  parseReadHeader,
  isReadChrome,
  stripIrcFormatting,
} from '../memos';
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
  // serverName is optional display sugar — used to attribute Inbox entries
  // with a human name instead of the raw serverId. Falls back to serverId.
  scope: { userId: string; serverId: string; serverName?: string };
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
  { name: 'join',    usage: '/join <channel>',     description: 'Join a channel' },
  { name: 'part',    aliases: ['leave'], usage: '/part [channel]', description: 'Leave the current or named channel' },
  { name: 'msg',     aliases: ['query'], usage: '/msg <nick> <text>', description: 'Send a direct message' },
  { name: 'me',      usage: '/me <action>',        description: 'Send an action (CTCP ACTION)' },
  { name: 'nick',    usage: '/nick <new-nick>',    description: 'Change your nickname on this server' },
  { name: 'away',    usage: '/away [message]',     description: 'Mark yourself as away (no message ⇒ comes back)' },
  { name: 'back',    usage: '/back',               description: 'Clear your away status' },
  { name: 'clear',   usage: '/clear',              description: "Clear this channel's local log" },
  { name: 'help',    usage: '/help',               description: 'List available commands' },
  // Raw-passthrough commands — the IRC daemon answers directly. Replies
  // surface on the ~server channel and inline in the Advanced panel.
  { name: 'whois',   usage: '/whois <nick>',       description: "Look up a user's account, channels, idle, server" },
  { name: 'whowas',  usage: '/whowas <nick>',      description: "Look up a recently-quit nick from the server's history" },
  { name: 'who',     usage: '/who <#chan-or-mask>',description: 'List users matching a channel or mask' },
  { name: 'list',    usage: '/list [filter]',      description: "Server channel directory (RPL_LIST). Filter syntax is daemon-specific" },
  { name: 'motd',    usage: '/motd [server]',      description: "Server's Message of the Day" },
  { name: 'lusers',  usage: '/lusers',             description: 'Server-wide user / channel / oper counts' },
  { name: 'version', usage: '/version [server]',   description: 'Server software banner' },
  { name: 'admin',   usage: '/admin [server]',     description: 'Network admin contact info' },
  { name: 'time',    usage: '/time [server]',      description: "Server's local time" },
  { name: 'links',   usage: '/links',              description: 'Map of servers linked into this network' },
  { name: 'mode',    usage: '/mode <target> <+/-modes> [args]', description: 'Set user or channel modes' },
  { name: 'raw',     usage: '/raw <IRC line>',     description: 'Send a raw IRC protocol line. Power-user escape hatch.' },
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

  // Detected services package, mirroring the engine's verdict. The
  // engine owns detection + auto-identify + VERSION probes (see
  // engine/irc/services.go); the ChatService just relays the value
  // into ChatState so the UI can render it. Null until the engine
  // has classified.
  private servicesFramework: 'atheme' | 'anope' | 'ergo' | 'unknown' | null = null;
  private unsubscribeServices: (() => void) | null = null;

  // Optional backend API for the automated nick-claim flow. When
  // present, claimNick() orchestrates the full mint-email →
  // REGISTER → poll-for-code → CONFIRM dance. When absent (tests
  // that don't exercise nick-claim; offline scenarios), claimNick()
  // resolves to { kind: 'unavailable' } so the caller can fall back
  // to the manual register+confirm form.
  private readonly nickClaimAPI: NickClaimAPI | null;

  constructor(
    private readonly session: ServerSession,
    private myNick: string,
    persistence?: ChatPersistence,
    deps?: { nickClaimAPI?: NickClaimAPI },
  ) {
    this.persistence = persistence ?? null;
    this.nickClaimAPI = deps?.nickClaimAPI ?? null;
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
    // Services-package verdict (atheme/anope/unknown). Engine fires
    // once per detected-state transition. Replays the current verdict
    // on subscribe if one has already landed.
    this.unsubscribeServices = this.session.onServicesFramework((fw) => {
      if (this.servicesFramework === fw) return;
      this.servicesFramework = fw;
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
    for (const handle of this.namesRetryTimers.values()) clearTimeout(handle);
    this.namesRetryTimers.clear();
    this.namesRetryCount.clear();
    // Drop the engine's services-framework subscription so a fresh
    // service-framework event after detach can't fire emit() against
    // a torn-down chat service.
    this.unsubscribeServices?.();
    this.unsubscribeServices = null;
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

  // Adopt the server-confirmed nick from a welcome-band numeric (001/004),
  // whose Target is the nick the server actually assigned us. No-op when
  // it's empty or unchanged. Keeps the AccountService impls (which cache
  // myNick for their NickServ-reply matching) in sync too.
  private syncMyNickFromNumeric(target: string | undefined): void {
    const nick = (target ?? '').trim();
    if (!nick || nick === '*' || nick === this.myNick) return;
    this.myNick = nick;
    this.anopeAccountService?._setMyNick(nick);
    this.athemeAccountService?._setMyNick(nick);
    this.ergoAccountService?._setMyNick(nick);
  }

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

  // Change the IRC nick on this server. Exposed as a public method so
  // a settings panel / quick-action button can drive a rename without
  // going through the slash-command parser. The same end-state as
  // typing `/nick <new>` in the chat input.
  changeNick(nick: string): void {
    this.cmdNick(nick);
  }

  // Send a NickServ IDENTIFY through the engine's dedicated command
  // (rather than a raw PRIVMSG) so the engine owns the password's
  // journey from renderer to wire. Auto-identify-on-connect goes
  // through `ConnectParams.nickservPassword` instead; this is the
  // manual / "Identify now" path.
  identifyNickserv(password: string): void {
    const trimmed = password.trim();
    if (!trimmed) return;
    this.session.nickservIdentify(trimmed);
  }

  // Re-fire IDENTIFY with the credentials stored for this connection.
  // Reads from the renderer's local credentials store (per-server
  // localStorage entries keyed by serverId). Used by the Advanced
  // panel's "Identify now" button.
  triggerAutoIdentify(): void {
    const serverId = this.persistence?.scope.serverId;
    if (!serverId) return;
    const creds = getServiceCredentialsStore().get(serverId);
    if (!creds?.nickservPassword) return;
    this.identifyNickserv(creds.nickservPassword);
  }

  // Re-send the confirmation email for a pending registration.
  // Anope-only on the wire; for Atheme/Ergo this resolves to
  // { kind: 'unsupported', verb: 'resend' } immediately without
  // contacting the server (caller's UI should have hidden the
  // affordance based on supportsResend()).
  async resendConfirmation(accountName: string): Promise<ResendResult | UnsupportedResult> {
    const fw = this.servicesFramework;
    if (fw === 'atheme') return this.getAthemeAccountService().resend(accountName);
    if (fw === 'ergo') return this.getErgoAccountService().resend(accountName);
    return this.getAnopeAccountService().resend(accountName);
  }

  // Reports whether this network's services package supports a
  // resend-confirmation-email operation. UI uses this to hide the
  // Resend button entirely on packages that don't (Atheme/Ergo).
  supportsResendConfirmation(): boolean {
    const fw = this.servicesFramework;
    if (fw === 'atheme') return this.getAthemeAccountService().supportsResend();
    if (fw === 'ergo') return this.getErgoAccountService().supportsResend();
    return this.getAnopeAccountService().supportsResend();
  }

  // Submit the confirmation code from the user's email to finalize
  // registration. Returns a discrete ConfirmResult so the panel can
  // surface wrong-code / expired / failed inline.
  async confirmAccount(accountName: string, code: string): Promise<ConfirmResult> {
    const fw = this.servicesFramework;
    if (fw === 'atheme') return this.getAthemeAccountService().confirm(accountName, code);
    if (fw === 'ergo') return this.getErgoAccountService().confirm(accountName, code);
    return this.getAnopeAccountService().confirm(accountName, code);
  }

  // Register a new NickServ account on this network. Returns a
  // discrete RegisterResult so the caller can route to the next
  // step (confirm-code prompt vs auto-identify) based on the kind.
  async registerAccount(password: string, email: string): Promise<RegisterResult> {
    const fw = this.servicesFramework;
    if (fw === 'atheme') return this.getAthemeAccountService().register(password, email);
    if (fw === 'ergo') return this.getErgoAccountService().register(password, email);
    return this.getAnopeAccountService().register(password, email);
  }

  // Silent INFO probe — learn a nick's server-side state without
  // touching it. Dispatches to the package impl. Today only the Anope
  // impl parses INFO; Atheme/Ergo throw "not migrated", so callers
  // should go through detectAccountState() which swallows that.
  private async infoAccount(accountName: string): Promise<AccountInfo> {
    const fw = this.servicesFramework;
    if (fw === 'atheme') return this.getAthemeAccountService().info(accountName);
    if (fw === 'ergo') return this.getErgoAccountService().info(accountName);
    return this.getAnopeAccountService().info(accountName);
  }

  // detectAccountState probes NickServ for the given nick (defaults to
  // the saved account nick / current nick) and writes a precise status
  // into the credentials store so the Identity panel can show the right
  // CTA — Claim only when genuinely unregistered, the confirm-code form
  // when registered-but-unconfirmed, the identify form when registered
  // + confirmed. Returns the resolved status, or undefined when we
  // couldn't determine it (no reply, or a package whose info() isn't
  // implemented) — in which case the panel leaves the prior status be.
  //
  // info() resolves only after the multi-line INFO block settles, so
  // this store.set lands AFTER the passive classifier (which also sees
  // those NOTICEs) — detection is the last writer and wins.
  async detectAccountState(accountName?: string): Promise<AccountStatus | undefined> {
    const serverId = this.persistence?.scope.serverId;
    if (!serverId) return undefined;

    const store = getServiceCredentialsStore();
    const existing = store.get(serverId) ?? {};
    const nick = (accountName || existing.accountName || this.myNick || '').trim();
    if (!nick) return undefined;

    let info: AccountInfo;
    try {
      info = await this.infoAccount(nick);
    } catch {
      // info() not implemented for this package (Atheme/Ergo until
      // their migration lands), or the probe threw — treat as
      // indeterminate rather than clobbering the badge.
      return undefined;
    }

    let status: AccountStatus;
    if (info.registered === false) status = 'no-account';
    else if (info.registered === true && info.confirmed === false) status = 'pending-confirmation';
    else if (info.registered === true) status = 'registered';
    else return undefined; // registered undefined → couldn't determine

    store.set(serverId, {
      ...existing,
      accountName: existing.accountName || info.accountName || nick,
      email: existing.email || info.email,
      status,
    });
    return status;
  }

  // resumePendingConfirmation finishes a stranded confirmation: the
  // nick is registered-but-unconfirmed and a backend claim is still
  // pending, so the email code was likely already captured by the
  // POP3 worker but never consumed (the original flow died after
  // REGISTER). We poll the claim for the captured code and fire
  // CONFIRM with it — no manual paste. Bounded to ~30s because for a
  // resume the code is usually already sitting in the DB; if it
  // isn't captured yet we return 'still-pending' and leave the manual
  // confirm/resend UI in place rather than spinning for the full TTL.
  async resumePendingConfirmation(
    accountName?: string,
    opts?: { signal?: AbortSignal },
  ): Promise<ResumeConfirmResult> {
    const serverId = this.persistence?.scope.serverId;
    if (!serverId) return { kind: 'unavailable', reason: 'no-server-id' };
    if (!this.nickClaimAPI) return { kind: 'unavailable', reason: 'no backend api' };

    const store = getServiceCredentialsStore();
    const existing = store.get(serverId) ?? {};
    const pending = existing.pendingRegistration;
    if (!pending) return { kind: 'unavailable', reason: 'no pending claim' };
    const acct = (accountName || existing.accountName || this.myNick || '').trim();
    if (!acct) return { kind: 'unavailable', reason: 'no-account-name' };

    const signal = opts?.signal;
    const deadline = Date.now() + 30_000;
    let code: string | undefined;
    while (true) {
      if (signal?.aborted) return { kind: 'still-pending' };
      let poll: NickClaimPollResponse;
      try {
        poll = await this.nickClaimAPI.getNickClaim(pending.id);
      } catch {
        if (Date.now() > deadline) return { kind: 'still-pending' };
        await sleepWithAbort(2000, signal);
        continue;
      }
      if (poll.status === 'captured' || poll.status === 'consumed') {
        if (poll.code) { code = poll.code; break; }
        return { kind: 'failed', reason: 'backend captured without code' };
      }
      if (poll.status === 'expired') return { kind: 'expired' };
      if (Date.now() > deadline) return { kind: 'still-pending' };
      await sleepWithAbort(2000, signal);
    }

    if (signal?.aborted) return { kind: 'still-pending' };

    const confirm = await this.confirmAccount(acct, code);
    switch (confirm.kind) {
      case 'confirmed': {
        // Account is confirmed. Clear the pending claim. If we still
        // hold the generated password (claimNick persists it at the
        // pending-confirmation step), kick auto-IDENTIFY so the badge
        // settles to identified; otherwise leave it 'registered' (the
        // user will need to identify manually / reset the password).
        store.set(serverId, {
          ...existing,
          accountName: acct,
          status: existing.nickservPassword ? 'identified' : 'registered',
          pendingRegistration: undefined,
        });
        if (existing.nickservPassword) this.triggerAutoIdentify();
        return { kind: 'confirmed' };
      }
      case 'wrong-code':
        return { kind: 'wrong-code' };
      case 'expired':
        return { kind: 'expired' };
      default:
        return { kind: 'failed', reason: confirm.reason };
    }
  }

  // claimNick orchestrates the full automated "claim this nick"
  // flow for signed-in users:
  //
  //   1. Generate a cryptographically random password.
  //   2. POST /me/nick-claims to mint a backend record and a
  //      reg-<userid>-<short>@boson.chat recipient address.
  //   3. Persist the {id, email} in the credentials store so a
  //      reload mid-flow can resume the poll.
  //   4. Call AccountService.register(pw, email) — fires the IRC
  //      NickServ REGISTER and awaits the "please CONFIRM" reply.
  //   5. Poll GET /me/nick-claims/{id} every 2s until status is
  //      captured (backend IMAP worker received the email and
  //      extracted the code) or expired / 30-min timeout.
  //   6. Call AccountService.confirm(accountName, code) — fires
  //      CONFIRM (or VERIFY REGISTER, per-package) and awaits
  //      the "confirmed" reply.
  //   7. Persist the generated password, clear pendingRegistration,
  //      return { kind: 'claimed' }.
  //
  // Honours an AbortSignal at every await point — caller can pull
  // the escape hatch and we'll dismantle cleanly. Bubbles up the
  // discrete failure modes the underlying ops surface (nick-taken,
  // expired, network down → unavailable, anything else → failed).
  async claimNick(accountName: string, opts?: { signal?: AbortSignal }): Promise<ClaimResult> {
    const signal = opts?.signal;
    if (!this.nickClaimAPI) {
      return { kind: 'unavailable', reason: 'no backend api wired' };
    }
    if (signal?.aborted) return { kind: 'cancelled' };

    const serverId = this.persistence?.scope.serverId;
    if (!serverId) {
      return { kind: 'failed', reason: 'no-server-id' };
    }

    // Step 1 — generate password.
    const password = generateClaimPassword();

    // Step 2 — backend mints the record + recipient address.
    let mint: NickClaimCreateResponse;
    try {
      mint = await this.nickClaimAPI.createNickClaim({ serverId, accountNick: accountName });
    } catch (err) {
      return { kind: 'unavailable', reason: claimErrReason(err) };
    }
    if (signal?.aborted) return { kind: 'cancelled' };

    // Step 3 — persist in credentials store so a mid-flow reload
    // can pick up where we left off. We don't write the password
    // until the flow succeeds — saving it earlier means a failed
    // claim would leave the auto-IDENTIFY-on-connect pointed at
    // a non-existent account, which then surfaces as identify-
    // failed on the next connect.
    const store = getServiceCredentialsStore();
    const existing = store.get(serverId) ?? {};
    store.set(serverId, {
      ...existing,
      accountName,
      email: mint.email,
      status: 'registering',
      pendingRegistration: { id: mint.id, email: mint.email },
    });

    // Step 4 — fire REGISTER on the IRC side.
    const registerResult = await this.registerAccount(password, mint.email);
    if (signal?.aborted) return { kind: 'cancelled' };
    switch (registerResult.kind) {
      case 'pending-confirmation':
        // The account now exists server-side (unconfirmed). Persist the
        // generated password + the pending claim NOW — not just on
        // success — so an interrupted flow (reload, or the panel's
        // auto-resume) can finish CONFIRM and later IDENTIFY without
        // losing the credential. Safe to save here precisely because
        // REGISTER landed: auto-identify will resolve to
        // 'identified-unconfirmed' rather than failing against a
        // non-existent account (the hazard the original deferral
        // guarded against, back when we saved before REGISTER).
        store.set(serverId, {
          ...existing,
          nickservPassword: password,
          accountName,
          email: mint.email,
          generatedPassword: true,
          status: 'pending-confirmation',
          pendingRegistration: { id: mint.id, email: mint.email },
        });
        // Fall through to the poll loop below.
        break;
      case 'registered':
        // Some servers skip email confirmation entirely. The auto-
        // identify in chat.service's post-confirm path will kick
        // in via the existing classifier; persist the password +
        // clear pendingRegistration so the badge settles cleanly.
        store.set(serverId, {
          ...existing,
          nickservPassword: password,
          accountName,
          email: mint.email,
          generatedPassword: true,
          status: 'registered',
        });
        return { kind: 'claimed' };
      case 'nick-taken':
        store.set(serverId, { ...existing, status: existing.status }); // clear pending
        return { kind: 'nick-taken' };
      case 'email-rejected':
      case 'failed':
        store.set(serverId, { ...existing, status: existing.status });
        return { kind: 'failed', reason: registerResult.kind === 'email-rejected'
          ? `server rejected email: ${registerResult.reason}`
          : registerResult.reason };
    }

    // Step 5 — poll for the captured code. 2s cadence, 30-min hard
    // cap (matches the backend TTL).
    const pollDeadline = Date.now() + 30 * 60 * 1000;
    let code: string | undefined;
    while (true) {
      if (signal?.aborted) {
        store.set(serverId, { ...existing }); // clear pendingRegistration
        return { kind: 'cancelled' };
      }
      if (Date.now() > pollDeadline) {
        store.set(serverId, { ...existing });
        return { kind: 'expired' };
      }

      let poll: NickClaimPollResponse;
      try {
        poll = await this.nickClaimAPI.getNickClaim(mint.id);
      } catch (err) {
        // A transient network blip shouldn't kill the whole flow;
        // sleep + retry. Hard failures (auth gone) will keep
        // bouncing and we'll fall out via the deadline.
        await sleepWithAbort(2000, signal);
        continue;
      }

      if (poll.status === 'captured' || poll.status === 'consumed') {
        if (poll.code) {
          code = poll.code;
          break;
        }
        // Captured but no code — shouldn't happen given the
        // backend contract. Treat as failed.
        store.set(serverId, { ...existing });
        return { kind: 'failed', reason: 'backend captured without code' };
      }
      if (poll.status === 'expired') {
        store.set(serverId, { ...existing });
        return { kind: 'expired' };
      }
      // Still pending — back off and try again.
      await sleepWithAbort(2000, signal);
    }

    if (signal?.aborted) return { kind: 'cancelled' };

    // Step 6 — fire CONFIRM (or VERIFY REGISTER) with the captured code.
    const confirmResult = await this.confirmAccount(accountName, code);
    if (signal?.aborted) return { kind: 'cancelled' };
    switch (confirmResult.kind) {
      case 'confirmed':
        // Step 7 — persist the password (auto-IDENTIFY will run on
        // next connect) + clear pendingRegistration.
        store.set(serverId, {
          ...existing,
          nickservPassword: password,
          accountName,
          email: mint.email,
          generatedPassword: true,
          status: 'identified',
        });
        return { kind: 'claimed' };
      case 'wrong-code':
        // The IMAP worker captured the wrong thing (parser bug)
        // or the user took a path we don't recognise.
        store.set(serverId, { ...existing });
        return { kind: 'failed', reason: 'server rejected the captured code' };
      case 'expired':
        store.set(serverId, { ...existing });
        return { kind: 'expired' };
      case 'failed':
        store.set(serverId, { ...existing });
        return { kind: 'failed', reason: confirmResult.reason };
    }
  }

  // Identify against NickServ with the given password. Returns a
  // discrete IdentifyResult so the caller can surface a precise
  // error (wrong-password / no-such-account / timeout) instead of
  // waiting for the credentials store to flip via the classifier.
  //
  // Routes by detected framework — all three impls share the same
  // logic via the runIdentify helper, but the per-framework dispatch
  // preserves the option for any package to override behaviour
  // later if needed.
  async identifyAccount(password: string): Promise<IdentifyResult> {
    const fw = this.servicesFramework;
    if (fw === 'atheme') {
      return this.getAthemeAccountService().identify(password);
    }
    if (fw === 'ergo') {
      return this.getErgoAccountService().identify(password);
    }
    return this.getAnopeAccountService().identify(password);
  }

  // Drop the NickServ account on this network. Returns a discrete
  // result kind so the caller (Identity panel) can switch without
  // parsing strings or knowing about per-package quirks.
  //
  // All three packages (Anope, Atheme, Ergo) are now migrated to
  // AccountService impls that own their per-package multi-step
  // dances internally. When the detector hasn't classified yet,
  // default to the Anope shape (same fallback adapters.ts uses).
  async dropAccount(accountName: string, password: string): Promise<DropResult> {
    const fw = this.servicesFramework;
    if (fw === 'atheme') {
      return this.getAthemeAccountService().drop(accountName, password);
    }
    if (fw === 'ergo') {
      return this.getErgoAccountService().drop(accountName, password);
    }
    // Anope + null + 'unknown' all route to the Anope impl as the
    // safe default.
    return this.getAnopeAccountService().drop(accountName, password);
  }

  private anopeAccountService: AnopeAccountService | null = null;
  private athemeAccountService: AthemeAccountService | null = null;
  private ergoAccountService: ErgoAccountService | null = null;

  // Lazily constructed the first time dropAccount() needs it; cached
  // so subscriber state (the status observable) persists across
  // operations. Reset when the session disconnects (in detach()).
  private getAnopeAccountService(): AnopeAccountService {
    if (!this.anopeAccountService) {
      this.anopeAccountService = new AnopeAccountService(this.session, {
        myNick: this.myNick,
      });
    } else {
      // Live-update myNick so the AccountService's NickServ-reply
      // filter stays correct across nick changes.
      this.anopeAccountService._setMyNick(this.myNick);
    }
    return this.anopeAccountService;
  }

  private getAthemeAccountService(): AthemeAccountService {
    if (!this.athemeAccountService) {
      this.athemeAccountService = new AthemeAccountService(this.session, {
        myNick: this.myNick,
      });
    } else {
      this.athemeAccountService._setMyNick(this.myNick);
    }
    return this.athemeAccountService;
  }

  private getErgoAccountService(): ErgoAccountService {
    if (!this.ergoAccountService) {
      this.ergoAccountService = new ErgoAccountService(this.session, {
        myNick: this.myNick,
      });
    } else {
      this.ergoAccountService._setMyNick(this.myNick);
    }
    return this.ergoAccountService;
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

  // Route a MemoServ NOTICE into the global Inbox. Picks up whatever
  // serverId we have from the persistence scope (the renderer-minted
  // id at connect time). When no persistence is configured we still
  // push to the store with an empty serverId — the Inbox UI resolves
  // the display name lazily, and an empty id just shows the memo
  // unattributed rather than dropping it.
  //
  // We don't parse the body — Atheme + Anope wrap memo events in
  // different banner formats and they evolve across versions. Storing
  // verbatim keeps the surface forward-compatible.
  private storeInboxEntry(from: string, body: string, kind: MemoKind, channel?: string): void {
    if (!body) return;
    const serverId = this.persistence?.scope.serverId ?? '';
    getMemoStore().append({
      serverId,
      // Prefer the human server name (passed in the persistence scope);
      // fall back to the serverId so an entry is never unattributed.
      serverName: this.persistence?.scope.serverName || serverId,
      sender: from,
      kind,
      channel,
      text: body,
      timestamp: Date.now(),
    });
  }

  // ---- MemoServ structured handling -------------------------------------
  // MemoServ output is turned into structured Inbox entries (not raw text).
  // The flow, built from real Anope + Atheme captures (see memo.parse.ts):
  //   1. On login the service NOTICEs "You have N new memos." → we auto-
  //      issue LIST. LIST is NON-destructive: it does NOT mark anything
  //      read, so memos stay unread server-side until the user opens one.
  //   2. LIST rows → one upserted Inbox entry per memo (sender, date,
  //      index, unread), deduped so reconnect re-LISTs don't pile up.
  //   3. readMemo() (user opens an unread entry) issues READ <n>; the
  //      reply body is captured here and fills the entry — the ONLY point
  //      a memo gets marked read server-side, by explicit user action.

  // Cooldown so a burst of duplicate "you have N memos" notices (or a
  // reconnect) doesn't fire LIST in a loop.
  private memoListCooldownUntil = 0;
  // In-progress READ body capture: header seen, collecting body lines.
  private memoReading: { index: number; lines: string[] } | null = null;

  // Strip Anope's trailing relative-time suffix ("(14 seconds ago)"),
  // which drifts between LISTs and would break dedup. The absolute
  // timestamp before it is stable; Atheme has no such suffix.
  private static normalizeMemoDate(date: string): string {
    return date.replace(/\s*\([^)]*ago\)\s*$/i, '').trim();
  }

  private handleMemoServ(body: string): void {
    const serverId = this.persistence?.scope.serverId;
    if (!serverId) return;
    const store = getMemoStore();
    const now = Date.now();

    // (1) New-memo notice → auto-LIST (cooldown-guarded, non-destructive).
    const newCount = parseNewMemoCount(body);
    if (newCount !== null) {
      if (newCount > 0 && now >= this.memoListCooldownUntil) {
        this.memoListCooldownUntil = now + 10_000;
        this.memoReading = null;
        this.session.privmsg('MemoServ', 'LIST');
      }
      return;
    }
    if (isNoMemos(body)) { this.memoReading = null; return; }

    // (2) READ output: a header starts body capture; subsequent non-chrome
    // lines are the body. Reset points: a new header, a count notice, or a
    // fresh readMemo() — so a stray later line can't bleed into a memo.
    const header = parseReadHeader(body);
    if (header) {
      this.memoReading = { index: header.index, lines: [] };
      return;
    }
    if (this.memoReading) {
      if (!isReadChrome(body)) {
        // Store the body with IRC formatting stripped — the inbox renders
        // plain text, and raw \x02/\x03 bytes would show as garbage.
        this.memoReading.lines.push(stripIrcFormatting(body));
        store.fillMemoBody(serverId, this.memoReading.index, this.memoReading.lines.join('\n'));
      }
      return;
    }

    // (3) LIST rows → upsert structured entries (deduped by sender+date).
    const row = parseListEntry(body);
    if (row) {
      store.upsertMemo({
        serverId,
        serverName: this.persistence?.scope.serverName || serverId,
        sender: row.sender,
        kind: 'memo',
        text: '',
        memoIndex: row.index,
        memoDate: ChatService.normalizeMemoDate(row.date),
        bodyFetched: false,
        read: !row.unread,
        timestamp: now,
      });
    }
  }

  // Fetch a memo's body on demand (Inbox open of an unread memo). Issues
  // READ <n>; handleMemoServ captures the reply + fills the entry. This is
  // the only place a memo is marked read server-side — by user action.
  readMemo(memoIndex: number): void {
    this.memoReading = null;
    this.session.privmsg('MemoServ', `READ ${memoIndex}`);
  }

  // Pipe a NickServ NOTICE body through the classifier. On a hit,
  // merge the new status onto the existing credentials entry so the
  // Services panel's badge stays current. We never overwrite saved
  // password / email / accountName from here — only the `status`
  // field — so the UI's "credentials are saved" state is untouched
  // by a transient identify-failed (the user might just be typing
  // a typo).
  //
  // Silent no-op when persistence isn't configured (no stable
  // serverId to key by) or when the body doesn't match any pattern.
  // Returns true if the body was a recognized NickServ reply (i.e. it
  // classified). Callers use that to treat transactional NickServ chatter as
  // connect-noise — keeping it out of the Inbox.
  private maybeUpdateAccountStatus(body: string): boolean {
    const kind = classifyNickServReply(body);
    if (!kind) return false;
    const serverId = this.persistence?.scope.serverId;
    if (!serverId) return true;

    // Side-effect-only kinds run BEFORE we filter on "did we get a
    // persisted-status mapping?" — they want to fire a follow-up
    // regardless of whether the badge should move.
    //
    // NOTE: 'drop-confirm-prompt' and 'drop-needs-password' used to
    // dispatch follow-up commands here. After Step 2 of the
    // AccountService migration (account-service-anope.ts), the
    // Anope drop conversation is encapsulated inside
    // AnopeAccountService.drop() — it owns its own multi-step
    // dance. Firing the follow-ups here too would cause double-
    // sends, so the side-effect branches were removed. The kinds
    // still classify (status badge can react), they just no longer
    // drive control flow from this method.

    // Generic verbatim replay: NickServ says "please confirm by
    // replying with /msg NickServ <verb> <args>". Parse the inline
    // command and send <verb> <args> verbatim to NickServ. Handles:
    //   * Atheme's token-based confirms
    //   * Anope's "DROP CONFIRM" two-step (covered by the simpler
    //     drop-confirm-prompt branch above too — first match wins)
    //   * irc.boson.chat's 3-arg "DROP <nick> <hostmask> <token>"
    //     variant that defies template categorization
    // Strips IRCv3 formatting bytes (\x02 bold, \x1d italic,
    // \x1f underline, \x0f reset) before parsing so wrapped
    // arguments like `\x02alice\x02` come out as `alice`.
    // Anope RESEND rejected because the rate-limit cooldown hasn't
    // elapsed. Anope's `resenddelay` default sits in the 5-min
    // range and the reply doesn't carry a precise remaining time,
    // so we pin the disable to Date.now() + 5min. UI subscribes
    // and dims the Resend button accordingly.
    if (kind === 'resend-cooldown') {
      const store = getServiceCredentialsStore();
      const existing = store.get(serverId) ?? {};
      store.set(serverId, {
        ...existing,
        resendCooldownUntil: Date.now() + 5 * 60 * 1000,
      });
      return true;
    }

    // NOTE: 'service-confirm-replay' used to dispatch the inline
    // /msg NickServ command back to the server here. After Steps 2
    // (Anope drop) and 3 (Atheme drop), both packages' drop flows
    // own their own replay logic internally — the side-effect was
    // removed to prevent double-sends. The classifier kind still
    // exists (it's emitted, just not acted on at this level) so
    // the badge tests / debug log still see it. Ergo drop and any
    // future REGISTER-confirm replay cases will move into their
    // respective AccountService impls in Steps 4 and 7.

    const rawNextStatus = nickServReplyToStatus(kind);
    if (!rawNextStatus) return true;
    const store = getServiceCredentialsStore();
    const existing = store.get(serverId) ?? {};

    // drop-success means the account is gone — wipe the saved
    // password + email so we don't auto-IDENTIFY into a void on the
    // next connect. Keep `accountName` around so the UI's empty state
    // can still say what was dropped (the user might want to re-
    // register the same nick).
    if (kind === 'drop-success') {
      store.set(serverId, {
        accountName: existing.accountName,
        status: 'no-account',
      });
      return true;
    }

    // Context-aware promotion / preservation:
    //
    // Anope (and Atheme in their unconfirmed-grace mode) lets an
    // account IDENTIFY *before* the email confirmation is done. A
    // raw `identified-success` reply means "your password matched",
    // not "your account is confirmed". If we previously persisted
    // `pending-confirmation` from the REGISTER reply, a naive
    // overwrite to plain `identified` would erase the confirm prompt
    // even though the server still considers the account unconfirmed
    // and will silently expire it. Map to `identified-unconfirmed`
    // so the UI keeps surfacing the code input.
    //
    // Symmetric case for `registration-confirmed`: if we're already
    // identified (or identified-unconfirmed) when CONFIRM lands,
    // promote to plain `identified`, not back down to `registered`.
    // The natural flow on irc.boson.chat is REGISTER → IDENTIFY →
    // (later) CONFIRM, with the user already logged in when the
    // code goes through.
    let nextStatus: typeof rawNextStatus = rawNextStatus;
    if (
      rawNextStatus === 'identified' &&
      (existing.status === 'pending-confirmation' ||
        existing.status === 'identified-unconfirmed')
    ) {
      nextStatus = 'identified-unconfirmed';
    } else if (
      rawNextStatus === 'registered' &&
      (existing.status === 'identified' ||
        existing.status === 'identified-unconfirmed')
    ) {
      nextStatus = 'identified';
    }

    if (existing.status !== nextStatus) {
      store.set(serverId, { ...existing, status: nextStatus });
    }

    // After a successful registration (either post-CONFIRM, or a
    // no-confirm flow where NickServ just says "account registered"),
    // auto-fire IDENTIFY using the saved password. The user explicitly
    // chose to register from the panel and saved their password in the
    // same action — sending IDENTIFY right away lands them in the
    // 'identified' state without a second click. The follow-up
    // classifier hit will overwrite our `registered` write with
    // 'identified' (or 'identify-failed' if something's off).
    if (kind === 'registration-confirmed' && existing.nickservPassword) {
      this.identifyNickserv(existing.nickservPassword);
    }

    // Verify-confirmation auto-probe. When we transition INTO
    // `identified` from anything other than identified, fire an
    // `INFO <acct>` to ground-truth whether the account is also
    // CONFIRMED — Anope (and Atheme in unconfirmed-grace mode) lets
    // you identify against an unconfirmed account, and the priority
    // logic above only catches the case where the prior status was
    // already `pending-confirmation`. After a cold reload + fresh
    // identify the prior was `unknown`, so we'd persist plain
    // `identified` and the user would never see the "confirm your
    // email" prompt until they manually ran Check status.
    //
    // The INFO reply flows back through this same handler:
    //   - "is an unconfirmed nickname" → kind=account-unconfirmed →
    //     status flips to identified-unconfirmed, UI surfaces the
    //     code input.
    //   - Anything else → no change; the badge stays identified.
    //
    // Only fires on the transition edge (prev !== identified) so we
    // don't loop on duplicate "you are now identified" replies.
    if (
      existing.status !== 'identified' &&
      nextStatus === 'identified' &&
      (existing.accountName || this.myNick)
    ) {
      const acct = existing.accountName || this.myNick;
      this.session.privmsg('NickServ', getAdapter(this.servicesFramework).buildInfo(acct).replace(/^\/msg NickServ\s+/i, ''));
    }
    return true;
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
      case 'nick':  return this.cmdNick(args);
      case 'clear': return this.cmdClear();
      case 'help':  return this.cmdHelp();
      case 'away':  return this.cmdAway(args);
      case 'back':  return this.cmdAway('');

      // Read-only / info commands. Each forwards to the daemon as a
      // raw IRC line; the reply (RPL_* numeric or NOTICE) flows back
      // through the normal event stream and surfaces on the ~server
      // channel by default. The Advanced settings panel additionally
      // captures these replies inline via its serverLog snapshot.
      case 'motd':    return this.session.raw(args ? `MOTD ${args}` : 'MOTD');
      case 'lusers':  return this.session.raw(args ? `LUSERS ${args}` : 'LUSERS');
      case 'version': return this.session.raw(args ? `VERSION ${args}` : 'VERSION');
      case 'admin':   return this.session.raw(args ? `ADMIN ${args}` : 'ADMIN');
      case 'time':    return this.session.raw(args ? `TIME ${args}` : 'TIME');
      case 'links':   return this.session.raw('LINKS');
      case 'whois':
        if (!args) return this.systemHere('Usage: /whois <nick>');
        return this.session.raw(`WHOIS ${args}`);
      case 'whowas':
        if (!args) return this.systemHere('Usage: /whowas <nick>');
        return this.session.raw(`WHOWAS ${args}`);
      case 'who':
        if (!args) return this.systemHere('Usage: /who <#channel-or-mask>');
        return this.session.raw(`WHO ${args}`);
      case 'list':
        // /list with no arg uses the dedicated typed method so the
        // engine's per-cycle accumulation kicks in (322s collected into
        // a single channel-directory frame). /list with a filter is a
        // raw passthrough — the engine doesn't try to accumulate
        // filtered LISTs (server may emit fewer 322s than the cache
        // expects).
        if (!args) { this.session.list(); return; }
        return this.session.raw(`LIST ${args}`);
      case 'mode':
        if (!args) return this.systemHere('Usage: /mode <target> <+/-modes> [args]');
        return this.session.raw(`MODE ${args}`);
      case 'raw':
        // Escape hatch: power-user can send any line. No validation —
        // the daemon will reject garbage with a 4xx numeric.
        if (!args) return this.systemHere('Usage: /raw <IRC line>');
        return this.session.raw(args);

      default:      return this.systemHere(`Unknown command: /${cmd}. Try /help.`);
    }
  }

  private cmdNick(args: string): void {
    const next = args.trim().split(/\s+/)[0];
    if (!next) return this.systemHere('Usage: /nick <new-nick>');
    // We don't validate locally — IRC nick rules vary (length, charset,
    // reserved prefixes) and the server's 432/433/437 error is more
    // authoritative than anything we could re-enforce. On success the
    // NICK echo comes back as a regular event and handleEvent renames
    // the member entries across every joined channel.
    this.session.nick(next);
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
  // Self-healing fallback for a NAMES reply that never arrived. A joined
  // channel ALWAYS has at least us, so an empty member list means the
  // NAMREPLY was lost (WS buffer pressure, engine restart, a services
  // hiccup). The event-driven triggers (join / channel-switch / first
  // message) are all one-shot and miss the "idle on an empty channel" case,
  // so we also keep re-requesting on a timer until it populates or we give up.
  private static readonly NAMES_RETRY_MS = 5000;
  private static readonly NAMES_MAX_RETRIES = 5;
  private namesRetryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private namesRetryCount = new Map<string, number>();

  private maybeRefreshNames(channel: string): void {
    const key = this.channelKey(channel);
    const ch = this.channels.get(key);
    if (!ch || !ch.joined) { this.clearNamesRetry(key); return; }
    if (ch.members.length > 0) { this.clearNamesRetry(key); return; }
    const last = this.namesRequestedAt.get(key) ?? 0;
    if (Date.now() - last >= ChatService.NAMES_THROTTLE_MS) {
      this.namesRequestedAt.set(key, Date.now());
      this.session.names(key);
    }
    // Arm the fallback in case this request is lost too. Bounded so a truly
    // unanswerable channel doesn't poll forever.
    this.scheduleNamesRetry(key);
  }

  private scheduleNamesRetry(key: string): void {
    if (this.namesRetryTimers.has(key)) return; // one in flight already
    if ((this.namesRetryCount.get(key) ?? 0) >= ChatService.NAMES_MAX_RETRIES) return;
    this.namesRetryCount.set(key, (this.namesRetryCount.get(key) ?? 0) + 1);
    const timer = setTimeout(() => {
      this.namesRetryTimers.delete(key);
      const ch = this.channels.get(key);
      if (ch && ch.joined && ch.members.length === 0) {
        this.maybeRefreshNames(key); // re-fires NAMES + re-arms (bounded)
      }
    }, ChatService.NAMES_RETRY_MS);
    this.namesRetryTimers.set(key, timer);
  }

  private clearNamesRetry(key: string): void {
    const t = this.namesRetryTimers.get(key);
    if (t) { clearTimeout(t); this.namesRetryTimers.delete(key); }
    this.namesRetryCount.delete(key);
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
      myNick: this.myNick,
      servicesFramework: this.servicesFramework,
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
      args: e.Args,
    });
    switch (e.Kind) {
      case 'PRIVMSG':
      case 'NOTICE': {
        if (!e.Target) return;
        const t = e.Target;
        const isToMe = t === this.myNick;
        const isChannel = t.startsWith('#') || t.startsWith('&');
        const isWildcard = isServerWildcardTarget(t);
        // Drop anything that isn't a channel, addressed to us, a known
        // pre-registration server target (*, AUTH), or from a service. Those
        // slip through to the dev-tools server log via appendServerLog above,
        // which is the right home for genuine wire noise.
        //
        // Service senders (NickServ/MemoServ/ChanServ/server-host) are kept
        // even when the target doesn't equal myNick: a service only ever
        // messages YOU directly (never a channel, never a third party), so a
        // service NOTICE we received is by definition for us. This makes
        // memo/status handling robust to a stale myNick (e.g. a collision
        // rename Nyan→Nyan2 the welcome-numeric sync somehow missed) — without
        // it, every MemoServ reply gets dropped right here.
        if (!isToMe && !isChannel && !isWildcard && !isServiceSender(e.From)) return;
        // Inbox routing uses an ALLOWLIST, not a denylist. The Inbox is for
        // things you read asynchronously and addressed-to-you: MemoServ memos
        // and real-user DMs (the DM mirror is further down). Everything else a
        // service sends — NickServ identify/confirm replies, ChanServ chatter,
        // the multi-line INFO/HELP dumps and CTCP "unknown command" rejections
        // that flood in on connect — is transactional and belongs in the quiet
        // ~server log, read in context. Trying to denylist every shape of that
        // connect noise was leaky (HELP/INFO dumps slipped through), so we only
        // ever promote MemoServ to the Inbox.
        //
        // NickServ replies still feed the account-status classifier (the
        // Services panel badge subscribes to it) — they just don't land in the
        // Inbox; they fall through to ~server below.
        // Service handling is NOT gated on isToMe: a NickServ/MemoServ NOTICE
        // we receive is always for us (see the drop guard above). Gating on
        // myNick here is exactly what silently broke memos on a renamed
        // connection.
        if (isNickServSender(e.From)) {
          this.maybeUpdateAccountStatus(e.Message);
        }
        if (isMemoServSender(e.From)) {
          this.handleMemoServ(e.Message);
          // Fall through: the raw MemoServ line still lands in the quiet
          // ~server log (operational/debug). The *structured* memo goes to
          // the Inbox via handleMemoServ — that's what the user reads.
        }
        // Decide which UI channel this message belongs in:
        //   - real channel (#foo): keep the original target
        //   - service / server-host / wildcard: pseudo `~server` (quiet log)
        //   - DM from a real user: virtual channel keyed by the sender
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
        // Mirror real-user DMs (1:1, addressed to us, not a channel, not the
        // server-wildcard pseudo-channel, not our own echo) into the Inbox so
        // it holds everything addressed to the user. Unlike services these
        // STAY visible as a chat conversation too.
        if (isToMe && !isChannel && !isWildcard && !isServiceSender(e.From) && e.From !== this.myNick) {
          this.storeInboxEntry(e.From, text, 'dm');
        }
        // Mirror channel mentions of our nick into the Inbox (Mentions tab)
        // so pings across servers collect in one place. Real channel messages
        // from someone else that name us; the source channel is carried for
        // click-through. (Our own lines never count as a mention.)
        if (isChannel && e.From !== this.myNick && containsNickMention(text, this.myNick)) {
          this.storeInboxEntry(e.From, text, 'mention', channel);
        }
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
        // IRC QUIT is a single global event but the per-channel display
        // must be scoped to channels the quitting nick was actually a
        // member of. We were previously emitting "<nick> quit" into
        // every channel — including ones the user had never been in —
        // which surfaces noise in unrelated DMs and channels.
        //
        // Now: for each channel, only record + persist the system
        // message if the quitting nick was in that channel's member
        // list. Always remove them from member lists either way (a
        // stale presence would be worse than a missed system message).
        this.channels.forEach((c) => {
          const wasMember = c.members.some((m) => m.nick === e.From);
          c.members = c.members.filter((m) => m.nick !== e.From);
          if (!wasMember) return;
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
          // Populated → cancel any pending self-heal retry. If it somehow
          // committed empty, leave the retry armed to try again.
          if (ch.members.length > 0) this.clearNamesRetry(key);
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
      case '001': {
        // RPL_WELCOME — the first parameter (Target) is the nick the server
        // actually registered us under, which can differ from the one we
        // requested (collision → Nyan2, server case-folding, enforced
        // length, …). Sync myNick so all `isToMe` routing — DM mirroring,
        // mentions, and NickServ/MemoServ handling — keys off our REAL nick
        // instead of the stale requested one. Without this, a renamed
        // connection silently drops every service reply (memos never fill,
        // DMs never mirror). See also the 004 sync below as a backstop.
        this.syncMyNickFromNumeric(e.Target);
        break;
      }
      case '004': {
        // RPL_MYINFO — engine forwards Args = [serverName, version].
        // Target is our nick; sync it here too as a backstop in case 001
        // wasn't surfaced (some daemons/engines coalesce the welcome burst).
        this.syncMyNickFromNumeric(e.Target);
        const args = e.Args ?? [];
        const next: ServerInfo = { ...this.serverInfo };
        if (args[0]) next.serverName = args[0];
        if (args[1]) next.version = args[1];
        this.serverInfo = next;
        this.emit();
        break;
      }
      case '900': {
        // RPL_LOGGEDIN (IRCv3) — the server confirms our account in
        // a side-channel. Format:
        //   :server 900 <nick> <nick>!<user>@<host> <account> :You are now logged in as <account>
        // Fires on SASL success, on NickServ CONFIRM completion, and
        // some daemons re-emit on every connect once identified. We
        // treat it as a strong "you're identified" signal and flip
        // the persisted status immediately — no NickServ NOTICE
        // round-trip needed. Account name lives in Args[2] on
        // engines that split params; fall back to e.Message tail.
        const serverId = this.persistence?.scope.serverId;
        if (!serverId) break;
        const store = getServiceCredentialsStore();
        const existing = store.get(serverId) ?? {};
        if (existing.status !== 'identified') {
          store.set(serverId, { ...existing, status: 'identified' });
        }
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

// ---- claimNick helpers ----------------------------------------------

// generateClaimPassword mints a 24-byte cryptographically random
// password, base64url-encoded. ~144 bits of entropy — well above
// any NickServ policy floor. The user never sees this string;
// it lives in the credentials store and drives auto-IDENTIFY on
// future connects.
function generateClaimPassword(): string {
  const buf = new Uint8Array(24);
  crypto.getRandomValues(buf);
  // base64url (RFC 4648 §5) — strip '=' padding so the password
  // is purely [A-Za-z0-9_-], avoiding NickServ command-parsing
  // surprises with `+` or `/`.
  let b64 = '';
  if (typeof btoa === 'function') {
    let bin = '';
    for (const byte of buf) bin += String.fromCharCode(byte);
    b64 = btoa(bin);
  } else {
    b64 = Buffer.from(buf).toString('base64');
  }
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// claimErrReason extracts a short message from a thrown HTTP error
// or other exception, for the ClaimResult.reason field. Doesn't
// throw.
function claimErrReason(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

// sleepWithAbort waits ms milliseconds, but resolves early when
// the AbortSignal fires. Used inside claimNick's poll loop.
function sleepWithAbort(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(t);
      resolve();
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
