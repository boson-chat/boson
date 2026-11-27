import { signal, type Signal } from '@preact/signals';
import type { IrcEvent, ServerSession } from '../engine';
import type { ChatHistoryStore } from '../history';
import { MemoryOlderStore, lineIdentity, type OlderStore } from '../history/older-store';
import { containsNickMention } from './mention';
import { isHistServReplay } from './histserv';
import { addresses, replyPrefix, resolveTextReply, REPLY_WINDOW, sameNick } from './replies';
import {
  REACT_TAG, UNREACT_TAG, applyReaction, mergeReactions, reactionOf, redactReaction,
  type ReactionEvent, type ReactionLog,
} from './reactions';
import { ReadMarkerStore } from './read-markers';
import type { NotifyEvent } from '../ui/notifier';
import {
  SERVICE_CHANNEL,
  classifyNickServReply,
  isMemoServSender,
  isNickServSender,
  isServerWildcardTarget,
  isServiceSender,
  maskServiceSecret,
  nickServReplyToStatus,
  SECRET_MASK,
} from './services';
import { getServiceCredentialsStore, type AccountStatus } from './services-credentials';
import { getAdapter } from './adapters';
import { AnopeAccountService } from './account-service-anope';
import { AthemeAccountService } from './account-service-atheme';
import { ErgoAccountService } from './account-service-ergo';
import { ChanServController } from '../chanserv/chanserv.controller';
import type { DropResult, IdentifyResult, RegisterResult, ConfirmResult, ResendResult, UnsupportedResult, AccountInfo } from './account-service';
import type { NickClaimCreateResponse, NickClaimPollResponse } from '../directory/directory.types';
import { isNickClaimDisabledError } from '../directory/nick-claim';

// NickClaimAPI is the subset of DirectoryService methods ChatService
// needs for the automated "claim this nick" flow. Injecting via an
// interface keeps the wiring testable (no real fetch in unit tests)
// and ChatService independent of the larger DirectoryService surface.
export interface NickClaimAPI {
  createNickClaim(input: { serverId: string; accountNick: string }): Promise<NickClaimCreateResponse>;
  getNickClaim(id: string): Promise<NickClaimPollResponse>;
  // False when the Boson network has nick claims turned off (GET /config).
  // Absent: assumed on; a 403 nick_claim_disabled still says otherwise.
  isEnabled?(): boolean;
  // Called when the backend answers 403 nick_claim_disabled (the admin
  // turned the feature off mid-session).
  onDisabled?(): void;
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
//   disabled        — the Boson network has nick claims turned off
//                     (GET /config, or 403 nick_claim_disabled). Caller
//                     shows the manual register+confirm form.
//   unavailable     — backend rejected the create (rate-limit, no
//                     auth, network unreachable). Caller should fall
//                     back to the manual register+confirm form.
//   failed          — anything else with a free-form reason string.
export type ClaimResult =
  | { kind: 'claimed' }
  | { kind: 'nick-taken' }
  | { kind: 'expired' }
  | { kind: 'cancelled' }
  | { kind: 'disabled' }
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
  ChannelListEntry,
  ChannelMemberMode,
  ChannelModes,
  ChatChannel,
  ChatMember,
  ChatMessage,
  ChatMessageKind,
  ChatState,
  MemberPrefix,
  ServerInfo,
  ServerLogEntry,
  WhoisInfo,
} from './chat.types';
import { prefixRank, banMask } from './channel-ops';
import { WHOIS_REPLIES, WHOIS_ONLY_WHILE_LOADING, applyWhoisReply } from './whois';
import { SeenStore, seenMask, type SeenRecord } from '../seen/seen.store';

// IRC can't carry an empty line, so a blank line inside a multi-line paste
// goes out as a single space: other clients show an empty line, and Boson
// gets the paragraph break back (screens/ChatLayout/markdown-blocks.ts).
export const BLANK_LINE = ' ';

// Maximum raw IRC events retained for the dev-tools server log. Old entries
// are evicted in FIFO order. 200 lines comfortably covers a full handshake
// (NOTICE chatter + RPL_WELCOME + MOTD + ISUPPORT bursts) plus a chunk of
// runtime traffic without ballooning memory.
const SERVER_LOG_CAP = 200;
// A sent message still unconfirmed after this long (see send()) gets the
// connection checked: a healthy server answers well within it.
const ACK_STALL_MS = 4000;
// echo-message: how long a sent line waits for its echo (see awaitEcho).
const ECHO_WAIT_MS = 60_000;
// A line longer than this (UTF-8 bytes) may come back in parts: the engine
// splits what doesn't fit one IRC line.
const ECHO_SPLIT_MIN_BYTES = 300;
// How long a rejoin (ChatService.rejoin) waits for the JOIN or a refusal.
const REJOIN_TIMEOUT_MS = 15_000;

// Stored history never holds the pending flag: it's about this connection.
function stripPending(m: ChatMessage): ChatMessage {
  if (!m.pending) return m;
  const { pending: _p, ...rest } = m;
  return rest;
}
// Default chathistory request size (messages per page), capped by the
// server's CHATHISTORY=<max> ISUPPORT token when smaller.
const CHATHISTORY_REQUEST_LIMIT = 50;
// Search's history requests (fetchHistory): the most asked for at once when
// the server doesn't say its own maximum (ISUPPORT CHATHISTORY=<max>), and
// how long one waits for its batch.
const HISTORY_QUERY_DEFAULT_LIMIT = 100;
const HISTORY_QUERY_TIMEOUT_MS = 15_000;

// A CHATHISTORY batch being received: the conversation's own backlog
// (latest / before), or a search's request (query), which goes back to
// whoever asked instead of into the conversation.
interface HistoryBatch {
  target: string;
  kind: 'latest' | 'before' | 'query';
  msgs: ChatMessage[];
  query?: HistoryQuery;
  // Items the server sent, rows or not (TAGMSGs, our own replayed joins,
  // HistServ's stand-ins…): a full page means there may be more.
  received?: number;
  // The oldest server time among them, rows or not: where the next
  // CHATHISTORY BEFORE starts (a page of events may make no row at all).
  oldest?: number;
}

/**
 * A page fetchHistory answers with: the rows, plus how many items the
 * server actually sent and the oldest one's server time — with
 * event-playback a page can be all joins / quits / TAGMSGs that make few
 * or no rows, and it's not the end of history for that.
 */
export type HistoryPage = ChatMessage[] & { received?: number; oldest?: number };

// History events (draft/event-playback): JOIN/PART/QUIT/KICK/NICK/TOPIC/MODE
// replayed inside a chathistory batch. They become the same rows live events
// make, at their server time, and never touch live state (members, topic,
// our nick or membership): the engine keeps them out of girc's state too.
const HISTORY_EVENT_KINDS = new Set(['JOIN', 'PART', 'QUIT', 'KICK', 'NICK', 'TOPIC', 'MODE']);
// A history event row and a row Boson made live for the same event, when
// they can't be matched by msgid: same kind, sender and text, this close.
const EVENT_DEDUPE_WINDOW_MS = 5_000;
const EVENT_ROW_KINDS: ReadonlySet<ChatMessageKind> = new Set(['join', 'part', 'quit', 'kick', 'system']);

interface HistoryQuery {
  seq: number;
  target: string;
  resolve: (msgs: HistoryPage) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** Where a fetchHistory page starts: before / around a message, by msgid or time. */
export type HistoryRef = { msgid: string } | { timestamp: number };
// On attach, private conversations with activity this recent get their
// backlog pulled too (CHATHISTORY TARGETS). Channels come from their JOIN.
const DM_BACKLOG_WINDOW_MS = 30 * 24 * 60 * 60_000;
const DM_BACKLOG_MAX_TARGETS = 50;
// A message whose IRCv3 server-time is older than this (relative to now) is
// treated as bouncer/buffer replay (backlog), not a live arrival — so it
// doesn't mark channels unread / notify / hit the Inbox. Live messages are
// stamped within network latency (sub-second), so the window is generous.
const BACKLOG_AGE_MS = 30_000;
// ZNC buffer playback without server-time: see ChatService.inZncPlayback.
const ZNC_QUERY_PLAYBACK = '\0query';
const ZNC_PLAYBACK_MAX_MS = 60_000;

// How long after the user's last command to a service (or its last reply
// line) its replies still go to the user's conversation with it.
const SERVICE_REPLY_WINDOW_MS = 30_000;

// The session, with every PRIVMSG it sends reported (target) first — how
// ChatService tells the app's automatic service requests from the user's.
function trackServiceSends(session: ServerSession, note: (target: string) => void): ServerSession {
  return new Proxy(session, {
    get(t, p) {
      if (p === 'privmsg') {
        return (target: string, ...rest: unknown[]) => {
          note(target);
          return (t.privmsg as (...a: unknown[]) => unknown)(target, ...rest);
        };
      }
      const v = Reflect.get(t, p, t) as unknown;
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(t) : v;
    },
  });
}

// A CTCP message: \x01COMMAND [args]\x01 (the closing \x01 is optional in
// the wild). Null for ordinary text.
export function parseCtcp(text: string | undefined): { command: string; args: string } | null {
  if (!text || text.charCodeAt(0) !== 1) return null;
  const body = text.slice(1).replace(/\x01$/, '');
  const sp = body.indexOf(' ');
  const command = (sp < 0 ? body : body.slice(0, sp)).toUpperCase();
  if (!command) return null;
  return { command, args: sp < 0 ? '' : body.slice(sp + 1) };
}

// Server clock skew estimation. A bouncer stamps server-time with its OWN
// clock; when that clock runs minutes slow, live messages from others sort
// above lines we just sent (stamped locally) and look like backlog (no unread
// or mention). Each un-batched non-message event (JOIN, numerics, PING…,
// which are never replayed) gives a sample `server − local`; the max over a
// recent window tracks the skew, since delays only push a sample lower.
// Corrections under SKEW_MIN_MS are jitter; over SKEW_MAX_MS, implausible.
const SKEW_WINDOW_MS = 10 * 60_000;
const SKEW_MAX_SAMPLES = 64;
const SKEW_MIN_MS = 1_500;
const SKEW_MAX_MS = 60 * 60_000;
const SKEW_SKIP_KINDS = new Set(['PRIVMSG', 'NOTICE', 'TAGMSG']);

// Hard ceiling on messages held in memory per channel. Bouncer reconnects
// replay the whole buffer each time, so without a bound a long session with
// churn balloons the heap (observed: 4 GB OOM). Generous enough to hold a full
// scroll-back session; the oldest are evicted on the live-append path once
// exceeded. Persistence keeps its own (separate, smaller) cap.
const IN_MEMORY_MESSAGE_CAP = 1500;
// Lines pushed out by that cap are kept aside (per conversation, newest
// this many) and handed back a page at a time on scroll-up when the server
// has no history command of its own: a plain ZNC with its buffers kept
// replays up to ~10k lines per channel on attach, and that is all the
// history it can ever give.
const OLDER_CAP = 10_000;
const OLDER_PAGE = 50;

// Memory windows (deps.windows; the app sets them, legacy callers keep the
// caps above). The conversation on screen, read at the bottom, keeps its
// newest `active` lines; the others a `tail` (sidebar previews, unread);
// the rest goes to the OlderStore (IndexedDB) and comes back on scroll-up.
// While the user reads further up nothing is trimmed off what they loaded;
// back at the bottom it's trimmed to the window again.
export interface MemoryWindows {
  active: number;
  tail: number;
  // Lines per scroll-up page from the OlderStore.
  page: number;
}
export const DEFAULT_WINDOWS: MemoryWindows = { active: 200, tail: 50, page: 100 };

// How long a scroll-back request waits for the server before the ribbon shows
// an error (covers a CHATHISTORY / *playback request that gets no reply).
const LOAD_OLDER_TIMEOUT_MS = 8_000;

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

// Getting our nick back after connecting under a fallback (see
// startNickReclaim): asks again after each of these delays.
// The server not taking a nick: 432 erroneous, 433 in use, 436 collision,
// 437 held (unavailable).
const NICK_REFUSALS = new Set(['432', '433', '436', '437']);
const NICK_RECLAIM_DELAYS_MS = [5_000, 15_000, 30_000, 60_000, 120_000, 300_000, 600_000];

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
  { name: 'seen',    usage: '/seen <nick>',        description: "What Boson remembers of a nick: last host, account, when and where (local only)" },
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
  { name: 'oper',    usage: '/oper <name> <password>', description: 'Authenticate as a server operator (IRCd oper block)' },
  // Channel-operator convenience verbs (the right-click menu + Channel
  // Settings modal are the primary surface; these mirror them for typists).
  { name: 'kick',    usage: '/kick <nick> [reason]', description: 'Kick a user from the current channel' },
  { name: 'ban',     usage: '/ban <nick|mask>',     description: 'Ban a user or mask from the current channel (+b)' },
  { name: 'unban',   usage: '/unban <mask>',        description: 'Remove a ban (-b)' },
  { name: 'op',      usage: '/op <nick>',           description: 'Grant channel operator (+o)' },
  { name: 'deop',    usage: '/deop <nick>',         description: 'Remove channel operator (-o)' },
  { name: 'halfop',  usage: '/halfop <nick>',       description: 'Grant half-op (+h)' },
  { name: 'voice',   usage: '/voice <nick>',        description: 'Grant voice (+v)' },
  { name: 'devoice', usage: '/devoice <nick>',      description: 'Remove voice (-v)' },
  { name: 'invite',  usage: '/invite <nick> [#channel]', description: 'Invite a user to a channel' },
  { name: 'topic',   usage: '/topic [new topic]',   description: 'Set (or view) the current channel topic' },
  { name: 'raw',     usage: '/raw <IRC line>',     description: 'Send a raw IRC protocol line. Power-user escape hatch.' },
];

function utf8Length(s: string): number {
  return new TextEncoder().encode(s).length;
}

// IRCv3 replies: a client-only tag carrying the msgid of the message
// answered. Still a draft spec, so servers (Ergo, soju) relay it as
// `+draft/reply`; the ratified name `+reply` is read too.
export const REPLY_TAG = '+draft/reply';
const REPLY_TAGS = [REPLY_TAG, '+reply'] as const;

// `{ replyTo }` from a line's tags, or nothing.
export function replyOf(tags: Record<string, string> | undefined): { replyTo?: string } {
  if (!tags) return {};
  for (const t of REPLY_TAGS) {
    const v = tags[t];
    if (v) return { replyTo: v };
  }
  return {};
}

// A deleted message as kept: who and when, nothing of what it said. What
// it answered stays (not shown: it keeps its place in a thread, and the
// replies under it in theirs: threads.ts).
function redactedCopy(m: ChatMessage): ChatMessage {
  return {
    id: m.id, kind: m.kind === 'notice' ? 'notice' : 'message', from: m.from, text: '', timestamp: m.timestamp,
    redacted: true,
    ...(m.msgid ? { msgid: m.msgid } : {}),
    ...(m.replyTo ? { replyTo: m.replyTo } : {}),
    ...(m.replyToId && !m.replyGuess ? { replyToId: m.replyToId } : {}),
    ...(m.serverTime !== undefined ? { serverTime: m.serverTime } : {}),
  };
}

// FAIL REDACT <code> …: what to tell the user.
function redactFailText(code: string, message: string | undefined): string {
  switch (code) {
    case 'REDACT_FORBIDDEN': return "You can't delete that message.";
    case 'UNKNOWN_MSGID': return "That message can't be deleted any more: the server no longer has it.";
    case 'INVALID_TARGET': return "Couldn't delete the message: no such conversation.";
    case 'REDACT_WINDOW_EXPIRED': return 'That message is too old to delete.';
    default: return message ? `Couldn't delete the message: ${message}` : "Couldn't delete the message.";
  }
}

export interface SendOptions {
  // The msgid of the message this one answers (a reply).
  replyTo?: string;
  // Its local id (a message without a msgid can be answered too: the text
  // form `nick: "quote..." …` says which, see replies.ts).
  replyToId?: string;
}

// ChatService owns channel/message state for the connected IRC session.
// It listens to engine events and exposes actions (join, send, setActive).
// Following our TS skill: single class, constructor DI, all state internal,
// subscribers see immutable snapshots.

// Internal channel record. Identical to the public ChatChannel except that
// `messages` is a `@preact/signals` Signal rather than a plain array, so a
// channel's message list is FINE-GRAINED reactive: appending to one channel
// re-renders only that channel's MessageList (which reads the signal), and
// getState() can expose the array by reference (peek) instead of deep-cloning
// every channel's messages on every emit (the old GC-thrash / OOM source).
// The PUBLIC ChatChannel keeps `messages: ChatMessage[]` — getState() peeks the
// signal — so consumers and tests reading `state.channels[i].messages` are
// unchanged.
type InternalChannel = Omit<ChatChannel, 'messages'> & { messages: Signal<ChatMessage[]> };

// Whether two copies of a line were sent at the same moment: by the server's
// own stamp when both have one (skew corrections differ between connections),
// else by our timestamp.
// The activity line for a topic change / channel mode change, live or replayed.
function topicChangeText(setter: string, topic: string): string {
  return topic ? `${setter} changed the topic to: ${topic}` : `${setter} cleared the topic`;
}

function modeChangeText(setter: string, args: readonly string[]): string {
  return `${setter || 'server'} sets mode ${args.join(' ')}`;
}

// Two runs of lines as one conversation in time order. Stable: among equal
// timestamps `first`'s lines stay ahead of `then`'s, each in its own order.
function byTime(first: readonly ChatMessage[], then: readonly ChatMessage[]): ChatMessage[] {
  return [...first, ...then].sort((a, b) => a.timestamp - b.timestamp);
}

function sameTime(a: ChatMessage, b: ChatMessage): boolean {
  return a.serverTime !== undefined && b.serverTime !== undefined
    ? a.serverTime === b.serverTime
    : a.timestamp === b.timestamp;
}

export class ChatService {
  private channels = new Map<string, InternalChannel>();
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
  // Recent `server-time − local` samples from live events (see SKEW_*).
  private clockSamples: Array<{ at: number; off: number }> = [];
  private clockOffset = 0;
  // ---- Chathistory (IRCv3 backlog/scrollback) -------------------------
  // IRCv3 reactions per conversation (key → target msgid → entries); see
  // reactions.ts. Kept apart from the channels: a reaction can arrive
  // before its message, or for a conversation not open yet.
  private readonly reactionLogs = new Map<string, Signal<ReactionLog>>();
  // Messages deleted (REDACT) per conversation, by msgid: scrubbed again if
  // a copy comes back (the older-lines store, a bouncer's replay).
  private readonly redactedIds = new Map<string, Set<string>>();
  // A hydrated line's id as stored (hydration gives each a fresh one), so
  // an update to it (reactions, deletion) replaces the stored row.
  private readonly storedIds = new Map<string, string>();
  // Active BATCH refs → buffered history messages, keyed by the batch ref.
  private readonly batches = new Map<string, HistoryBatch>();
  // Refs of batches nested in a history batch (aliases in `batches`).
  private readonly nestedBatches = new Set<string>();
  // Per conversation: the oldest server time any history page reached,
  // rows or not. Scroll-back asks for what's before the older of this and
  // the top row, so a page of events that made no row isn't asked again.
  private readonly historyFloor = new Map<string, number>();
  // Channels we've already auto-requested LATEST backlog for (once per open).
  private readonly historyRequested = new Set<string>();
  // Set once the server 421s a CHATHISTORY command (advertised the cap but
  // doesn't implement it, e.g. ZNC < 1.8 relaying upstream). Disables further
  // requests for this connection.
  private chathistoryUnsupported = false;
  // Lines older than what's in memory, oldest first (see OLDER_CAP), and
  // how many of them scroll-up has put back, which raises that
  // conversation's in-memory cap so live traffic doesn't push them out again.
  private readonly older: OlderStore;
  // Whether the OlderStore is shared with the next ChatService of this
  // server (DirectoryBloc's), so a reconnect needn't hand it over.
  private readonly olderShared: boolean;
  private readonly revealed = new Map<string, number>();
  // Memory windows (null: the legacy caps).
  private readonly windows: MemoryWindows | null;
  // The conversation on screen and whether it's read at the bottom (from
  // the message list: setViewport).
  private viewportAtBottom = true;
  private visibleKey: string | null = null;
  // Open `chathistory-targets` batches (ref → targets listed so far): the
  // reply to the CHATHISTORY TARGETS sent on attach.
  private readonly targetBatches = new Map<string, string[]>();
  // ZNC playback: `PLAY *` went out for this attach, covering every buffer
  // (channels and queries), so per-JOIN requests would only repeat it.
  private playedAll = false;
  // Per-channel kind of the in-flight request, read when its BATCH starts,
  // and when it went out (historySeq), to tell it apart from a search's.
  private readonly pendingHistoryKind = new Map<string, 'latest' | 'before'>();
  private readonly pendingHistorySeq = new Map<string, number>();
  private historySeq = 0;
  // Search's own history requests (fetchHistory), per lowercased target,
  // oldest first: answered in batches of their own, kept out of the
  // conversation.
  private readonly historyQueries = new Map<string, HistoryQuery[]>();
  // Per-channel watchdog for an in-flight scroll-back request. If the server
  // never answers (no BATCH at all), this fires and surfaces an error in the
  // ribbon instead of leaving the spinner stuck. Cleared when a flush resolves.
  private readonly loadOlderTimers = new Map<string, ReturnType<typeof setTimeout>>();
  // NAMREPLY (353) lines may arrive in multiple parts for the same channel;
  // accumulate here and commit when ENDOFNAMES (366) arrives.
  private pendingMembers = new Map<string, ChatMember[]>();
  // RPL_BANLIST (367) lines accumulate here between a `MODE #chan +b` request
  // and RPL_ENDOFBANLIST (368), keyed by channelKey — mirrors pendingMembers.
  private pendingBans = new Map<string, ChannelListEntry[]>();

  // RPL_WHOREPLY (352) may arrive before NAMREPLY has committed the
  // member list to the channel record — depending on the server, /WHO
  // can be processed before the post-JOIN NAMES burst. We buffer flags
  // keyed by (channelKey, lower(nick)) and apply them whenever the
  // member surface (NAMREPLY commit OR member-update push) catches up.
  private pendingWhoReplies = new Map<string, Map<string, WhoReply>>();

  // The channel to show once it's joined (restoreActiveChannel), and the
  // fallback timer armed when another channel joins first.
  private preferredActive: string | null = null;
  private preferredTimer: ReturnType<typeof setTimeout> | null = null;

  // WHOIS results by lower(nick), for profiles. A signal so the profile on
  // screen re-renders as each reply lands, without a whole-chat emit.
  readonly whois = signal<ReadonlyMap<string, WhoisInfo>>(new Map());
  // What we last knew of each nick (user@host, account, realname, when and
  // where), kept after they leave. Local only. Shared by this server's
  // connections when the app passes one in (deps.seen), else this
  // connection's own, in memory.
  readonly seen: SeenStore;
  // Read markers (see read-markers.ts and the "Read markers" section).
  private readonly readMarkers: ReadMarkerStore;
  // Conversations whose marker this run only guessed (the attach time,
  // for one never read before): a server's MARKREAD replaces it outright.
  private readonly guessedMarkers = new Set<string>();
  // What the server last said (or was told) each conversation is read up
  // to, so we only send MARKREAD when it moves past that.
  private readonly serverMarkers = new Map<string, number>();
  // Debounced MARKREAD sends, per conversation: the stamp to send.
  private readonly markReadPending = new Map<string, number>();
  private markReadTimer: ReturnType<typeof setTimeout> | null = null;
  // When this connection registered (001): the baseline for a conversation
  // with no marker — what came before it is history, what came after is new.
  private attachedAt = 0;
  // Nicks (lower-case) the user /whois'd by hand, until the reply ends: a
  // 401 for one prints what we remember of them.
  private readonly typedWhois = new Set<string>();

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
  // Channel registration (ChanServ) state for this connection; created on
  // attach. Null on hand-rolled session fakes without onEvent.
  private chanservCtl: ChanServController | null = null;
  private unsubscribeServices: (() => void) | null = null;
  private unsubscribeBouncerUpstream: (() => void) | null = null;

  // Optional backend API for the automated nick-claim flow. When
  // present, claimNick() orchestrates the full mint-email →
  // REGISTER → poll-for-code → CONFIRM dance. When absent (tests
  // that don't exercise nick-claim; offline scenarios), claimNick()
  // resolves to { kind: 'unavailable' } so the caller can fall back
  // to the manual register+confirm form.
  private readonly nickClaimAPI: NickClaimAPI | null;

  // True when this connection routes through a bouncer (ZNC/soju). The bouncer
  // is the source of truth for history: it replays its own buffer on every
  // attach. So we must NOT also persist + re-hydrate a local copy — doing so
  // double-counts on every reconnect (messages stack up, growing each restart)
  // and can resurrect stale DM/service tabs. Inbox attribution still uses the
  // persistence scope; only message store + hydrate are skipped.
  private readonly bouncerConn: boolean;
  private readonly onBouncerUpstreamWanted: ((wanted: boolean) => void) | null;

  // Which server this connection is, for everything keyed per server that is
  // NOT chat history: the NickServ credentials store (account status badge,
  // claim, auto-identify), MemoServ → Inbox, notifications. Taken from the
  // persistence scope when there is one, else from deps.server, else the
  // session's own serverId — guests have no persistence (no userId) but still
  // have a stable server id, and without it every NickServ reply and memo was
  // silently dropped for them.
  private readonly serverScope: { serverId: string; serverName?: string } | null;
  // Unsubscribes the credentials-store watch that identifies with a NickServ
  // password arriving after connect (see watchLatePassword).
  private unsubscribeCreds: (() => void) | null = null;
  // Whether the engine got a NickServ password at connect time (and so will
  // auto-IDENTIFY on welcome by itself). Snapshot taken in attach().
  private passwordAtConnect = false;

  // The connection. Every PRIVMSG the app sends through it to a service
  // counts as an automatic request (see serviceAsks); only the compose path
  // (send → sendTracked) marks one as the user's.
  private readonly session: ServerSession;

  constructor(
    session: ServerSession,
    private myNick: string,
    persistence?: ChatPersistence,
    deps?: {
      nickClaimAPI?: NickClaimAPI;
      bouncer?: boolean;
      server?: { serverId: string; serverName?: string };
      // Told when the user asks the bouncer to connect (true) or disconnect
      // (false) its network, so the choice can outlive this connection.
      onBouncerUpstreamWanted?: (wanted: boolean) => void;
      // Where lines that leave memory go (IndexedDB in the app; shared
      // across this server's connections). Default: in memory.
      olderStore?: OlderStore;
      // Small in-memory windows (see MemoryWindows); off by default.
      windows?: MemoryWindows;
      // Remembered identities ("seen"), one per server. Default: in memory.
      seen?: SeenStore;
      // How far each conversation was read, one per (user, server), kept
      // across runs (see read-markers.ts). Default: in memory.
      readMarkers?: ReadMarkerStore;
      // Where the detected services package is remembered per server, so
      // the next connect skips the detection probe (see services-verdict.ts).
      servicesVerdicts?: { save(serverId: string, framework: string): void };
      // Where this device's nick for the server is remembered, so the next
      // connect asks for it (server-nick.ts): the one the user picks (/nick,
      // Change nick) once the server takes it, and the one a bouncer keeps
      // the shared connection on. `pending` follows a change the user asked
      // for that the server hasn't answered yet (null: answered), so a
      // reconnect in between can still make it (deps.pendingNick).
      nickChoice?: { save(nick: string): void; pending?(nick: string | null): void };
      // A nick change the user asked for on the previous connection that
      // the server never answered: still theirs to make on this one.
      pendingNick?: string;
    },
  ) {
    this.session = trackServiceSends(session, (target) => this.noteServiceAsk(target, 'auto'));
    this.servicesVerdicts = deps?.servicesVerdicts ?? null;
    this.seen = deps?.seen ?? new SeenStore('memory');
    this.readMarkers = deps?.readMarkers ?? new ReadMarkerStore('memory');
    this.older = deps?.olderStore ?? new MemoryOlderStore(OLDER_CAP);
    this.olderShared = !!deps?.olderStore;
    this.windows = deps?.windows ?? null;
    this.persistence = persistence ?? null;
    const sid = (session as Partial<ServerSession>).serverId;
    this.serverScope = persistence?.scope ?? deps?.server ?? (sid ? { serverId: sid } : null);
    this.nickClaimAPI = deps?.nickClaimAPI ?? null;
    this.bouncerConn = deps?.bouncer ?? false;
    this.onBouncerUpstreamWanted = deps?.onBouncerUpstreamWanted ?? null;
    // Per-server config flag: surface "via bouncer" in the server-info badge.
    // (Scroll-back itself is gated on the chathistory / playback capability,
    // not on this — a bouncer with neither offers no scroll-back.)
    if (deps?.bouncer) {
      this.serverInfo = { ...this.serverInfo, bouncer: true, bouncerConfigured: true };
    }
    this.wantedNick = myNick;
    this.requestedNick = myNick;
    this.nickChoice = deps?.nickChoice ?? null;
    this.userNickAsk = deps?.pendingNick?.trim() || null;
  }

  // ----- Getting our nick back -----
  //
  // The nick we connected with (or last asked for with /nick). When the
  // server registers us under a fallback instead (nick_, because our previous
  // connection still holds the nick, typically for a minute after a reload),
  // we keep asking for it back on a backoff, say so once, and say when it
  // worked. Not when the server owns the nick (serverOwnsNick: a bouncer or
  // bridge whose one connection every device of the user's shares), nor when
  // the server welcomed us under another nick without refusing ours.
  //
  // On a connection whose nick the server owns the app never sends NICK on
  // its own: not to get a nick back, not when the nick's holder leaves, not
  // after a refusal (the engine's nick_ fallback is for registration only),
  // not to follow a new Boson handle. It takes the nick the server has and
  // remembers it as this device's nick for the server. Only the user's own
  // /nick or Change nick sends NICK (and such a change still unanswered when
  // the connection dropped, deps.pendingNick).
  private wantedNick: string;
  // The nick this connection registered with, whether the server refused
  // it while registering (in use, erroneous, held: the engine fell back to
  // nick_), and a nick the user asked for that the server hasn't answered.
  private readonly requestedNick: string;
  private regNickRefused = false;
  private userNickAsk: string | null = null;
  private readonly nickChoice: { save(nick: string): void; pending?(nick: string | null): void } | null;
  // Latched once the connection shows the server keeps the nick for us (see
  // serverOwnsNick).
  private nickOwnedSeen = false;
  private reclaimTimer: ReturnType<typeof setTimeout> | null = null;
  private reclaimAttempt = 0;
  private reclaimNoted = false;

  private stopNickReclaim(): void {
    if (this.reclaimTimer) { clearTimeout(this.reclaimTimer); this.reclaimTimer = null; }
    this.reclaimAttempt = 0;
    this.reclaimNoted = false;
  }

  // Whether the server owns our nick: a bouncer (routed through one, or
  // ZNC / soju.im/bouncer-networks seen on the wire), or a server that
  // showed it keeps a connection of its own for us: it welcomed us under
  // another nick than the one we registered with though it refused none
  // (evrd's managed bridge, on the nick device A picked), or it renamed our
  // registration nick to the one it welcomed us under (the bouncer's
  // "you're <nick>" line).
  private serverOwnsNick(): boolean {
    return this.bouncerConn || this.nickOwnedSeen || !!this.serverInfo.bouncer;
  }

  /** Whether NICK is the user's alone to send here (see serverOwnsNick). */
  nickOwnedByServer(): boolean {
    return this.serverOwnsNick();
  }

  // The nick the server has is this device's nick for it now.
  private takeServerNick(): void {
    if (!this.myNick) return;
    this.wantedNick = this.myNick;
    if (this.savedServerNick === this.myNick) return;
    this.savedServerNick = this.myNick;
    this.nickChoice?.save(this.myNick);
  }
  private savedServerNick: string | null = null;

  // The user's nick change is answered (taken or refused): nothing pending.
  private settleUserNickAsk(): void {
    if (this.userNickAsk === null) return;
    this.userNickAsk = null;
    this.nickChoice?.pending?.(null);
  }

  private hasWantedNick(): boolean {
    return !this.wantedNick || this.myNick.toLowerCase() === this.wantedNick.toLowerCase();
  }

  // On welcome, under another nick than the one registered with though the
  // server refused none: it's the server's choice (a bouncer attaching us to
  // its connection, already on the nick the user picked; a server enforcing
  // nick = account). Take it as the nick to keep, rather than fight it back
  // to the one we asked for. A collision fallback (nick_ after 433) isn't.
  // On a connection whose nick the server owns, that nick is this device's
  // nick from now on (saved), unless the user's own change from before a
  // reconnect is still unanswered: that one is made now.
  private adoptServerNick(): void {
    const refused = this.regNickRefused;
    this.regNickRefused = false;
    if (!this.myNick) return;
    const same = (a: string | null, b: string | null) => !!a && !!b && a.toLowerCase() === b.toLowerCase();
    if (!refused && !same(this.myNick, this.requestedNick)) this.nickOwnedSeen = true;
    const ask = this.userNickAsk;
    if (ask && same(this.myNick, ask)) {
      // registered with the change the user asked for, and it was taken
      this.userNickAsk = null;
      this.wantedNick = this.myNick;
      this.nickChoice?.save(this.myNick);
      return;
    }
    if (ask && refused && same(this.requestedNick, ask)) this.settleUserNickAsk();
    if (!this.serverOwnsNick()) return;
    if (this.userNickAsk) {
      this.wantedNick = this.userNickAsk;
      this.session.nick(this.userNickAsk);
      return;
    }
    if (refused) { this.wantedNick = this.myNick; return; }
    this.takeServerNick();
  }

  // A nick numeric (432 erroneous, 433 in use, 436 collision, 437 held): while
  // registering, the server didn't take the nick we asked for; after, a
  // /nick of the user's failed (not to be remembered).
  private noteNickRefused(e: IrcEvent): void {
    if (!this.welcomed) { this.regNickRefused = true; return; }
    const nick = (e.Args?.[1] ?? e.Target ?? '').toLowerCase();
    if (this.userNickAsk && (!nick || nick === this.userNickAsk.toLowerCase())) this.settleUserNickAsk();
    // Where the server owns the nick, the refused one isn't to be had later
    // either: the connection stays on the nick it has.
    if (this.serverOwnsNick() && this.myNick) this.wantedNick = this.myNick;
  }

  // Our nick changed: the answer to the user's /nick is remembered as their
  // pick for this server.
  // A rename nobody here asked for: where the server owns the nick, it's
  // the nick now (another device of the user's renamed the shared
  // connection, or the bouncer did) and is remembered; elsewhere it's not
  // fought when we had the nick we wanted, and not remembered (services'
  // Guest…).
  private noteOwnNickChange(newNick: string, hadWanted: boolean): void {
    if (this.userNickAsk && newNick.toLowerCase() === this.userNickAsk.toLowerCase()) {
      this.userNickAsk = null;
      this.wantedNick = newNick;
      this.nickChoice?.save(newNick);
      return;
    }
    if (this.userNickAsk) return; // still waiting for the user's change
    if (this.serverOwnsNick()) this.takeServerNick();
    else if (hadWanted && this.welcomed) this.wantedNick = newNick;
  }

  // `:<the nick we registered with> NICK <our nick>` once welcomed under
  // that nick: a bouncer telling the client which nick its connection is
  // on (evrd, soju, ZNC). The server owns the nick.
  private isRegistrationNickEcho(from: string, newNick: string): boolean {
    if (!this.welcomed || !from || !this.requestedNick) return false;
    return from.toLowerCase() === this.requestedNick.toLowerCase()
      && newNick.toLowerCase() === this.myNick.toLowerCase()
      && from.toLowerCase() !== this.myNick.toLowerCase();
  }

  // After registration: start getting the nick back when we didn't get it.
  private startNickReclaim(): void {
    this.stopNickReclaim();
    if (this.serverOwnsNick() || this.hasWantedNick()) return;
    this.scheduleNickReclaim();
  }

  private scheduleNickReclaim(): void {
    if (this.reclaimAttempt >= NICK_RECLAIM_DELAYS_MS.length) return;
    const delay = NICK_RECLAIM_DELAYS_MS[this.reclaimAttempt++]!;
    this.reclaimTimer = setTimeout(() => {
      this.reclaimTimer = null;
      this.tryReclaimNick();
    }, delay);
  }

  private tryReclaimNick(): void {
    if (this.serverOwnsNick() || this.hasWantedNick()) return;
    if (!this.reclaimNoted) {
      this.reclaimNoted = true;
      this.noteHere(`“${this.wantedNick}” is still in use, most likely by your previous session, so you're “${this.myNick}” for now. Boson will switch you back as soon as it's free.`);
    }
    this.session.nick(this.wantedNick);
    this.scheduleNickReclaim();
  }

  // The holder of our nick left or renamed: ask right away.
  private nickFreed(nick: string): void {
    if (this.serverOwnsNick() || this.hasWantedNick() || !this.welcomed) return;
    if (nick.toLowerCase() !== this.wantedNick.toLowerCase()) return;
    this.session.nick(this.wantedNick);
  }

  // Whether to persist + hydrate messages locally. Off for bouncer connections
  // (the bouncer replays its buffer; a local copy would duplicate).
  private get persistMessages(): boolean {
    return this.persistence !== null && !this.bouncerConn;
  }

  // The conversations and their messages, for the ChatService that replaces
  // this one when the connection drops and is made again (DirectoryBloc
  // mints a fresh one per connection). Without the handoff, everything
  // already read vanishes on a reconnect: in memory only on a bouncer or
  // for a guest, and a bouncer that clears its buffers once played (ZNC's
  // default) won't send those lines again.
  // The open conversation is marked `active` (and kept even when empty), so
  // the reconnect stays on it rather than falling back to the splash.
  exportConversations(): Array<{ name: string; messages: ChatMessage[]; older?: ChatMessage[]; active?: true }> {
    const out: Array<{ name: string; messages: ChatMessage[]; older?: ChatMessage[]; active?: true }> = [];
    for (const ch of this.channels.values()) {
      const messages = ch.messages.peek();
      // A shared store stays with the server; a private one (memory) is
      // handed over whole.
      const held = !this.olderShared && this.older.has(ch.name) ? this.older.takeNewest(ch.name, OLDER_CAP) : null;
      const older = Array.isArray(held) && held.length > 0 ? held : undefined;
      if (older) this.older.put(ch.name, older);
      const active = ch.name === this.activeChannel;
      if (messages.length > 0 || older || active) {
        out.push({ name: ch.name, messages, ...(older ? { older } : {}), ...(active ? { active: true as const } : {}) });
      }
    }
    return out;
  }

  // Take over a predecessor's conversations (exportConversations). Call
  // before attach(): the reconnect's backlog and rejoins then dedupe
  // against them like any other line already shown.
  seedConversations(convs: ReadonlyArray<{ name: string; messages: readonly ChatMessage[]; older?: readonly ChatMessage[]; active?: true }>): void {
    for (const c of convs) {
      if (c.active && !this.activeChannel) {
        this.ensureChannel(c.name);
        this.activeChannel = this.channelKey(c.name);
      }
      if (c.messages.length === 0 && !c.older?.length) {
        if (this.older.has(this.channelKey(c.name))) { this.ensureChannel(c.name); this.markScrollbackAvailable(); }
        continue;
      }
      const ch = this.ensureChannel(c.name);
      if (c.older?.length) this.stashOlder(this.channelKey(c.name), c.older);
      else if (this.older.has(this.channelKey(c.name))) this.markScrollbackAvailable();
      const fresh = c.messages.filter((m) => !this.isDuplicateMessage(ch, m));
      const merged = [...fresh, ...ch.messages.peek()].sort((a, b) => a.timestamp - b.timestamp);
      ch.messages.value = this.capMessages(this.channelKey(c.name), merged);
    }
    this.emit();
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
      const sid = this.serverScope?.serverId;
      if (sid && fw) this.servicesVerdicts?.save(sid, fw);
      this.chanservCtl?.updateSignals();
      this.emit();
    });
    this.chanservCtl?.dispose();
    this.chanservCtl = new ChanServController(
      (t, m) => this.session.privmsg(t, m),
      {
        signals: () => ({ framework: this.servicesFramework, version: this.serverInfo.version, network: this.serverInfo.network }),
        myAccount: () => this.myAccount,
        checkAccount: () => { if (this.welcomed && this.myNick) this.requestWhois(this.myNick); },
      },
    );
    // Bouncer upstream state (is ZNC connected to the real network?).
    // Sticky on the session, so a late attach replays the current value.
    // Optional-call: lightweight test fakes may not implement it.
    this.unsubscribeBouncerUpstream = this.session.onBouncerUpstream?.((upstream) => {
      if (this.serverInfo.bouncerUpstream === upstream) return;
      // Only bouncer connections report upstream state, so this also
      // latches the "via bouncer" flag. Connected settles any certificate
      // prompt: ZNC got through.
      this.serverInfo = { ...this.serverInfo, bouncer: true, bouncerUpstream: upstream };
      if (upstream === 'connected') this.clearBouncerCert();
      this.emit();
    }) ?? null;
    this.watchLatePassword();
  }

  // A NickServ password that reaches the credentials store only AFTER this
  // connection started — typically the E2E-encrypted copy pulled from the
  // backend on a fresh device, whose session restore connects before that
  // pull lands — would otherwise sit unused until the next connect: the
  // engine only auto-IDENTIFYs with the password it was given at connect.
  // So identify with it ourselves, either right away (already welcomed) or
  // on 001. Only when nothing has happened account-wise yet (status unset)
  // and no password was there at connect; flows that write a password with
  // a status (claim, register) drive identify themselves.
  private watchLatePassword(): void {
    const serverId = this.serverScope?.serverId;
    if (!serverId || this.unsubscribeCreds) return;
    const store = getServiceCredentialsStore();
    this.passwordAtConnect = Boolean(store.get(serverId)?.nickservPassword);
    let hadPassword = this.passwordAtConnect;
    this.unsubscribeCreds = store.subscribe(serverId, (creds) => {
      const pw = creds?.nickservPassword;
      const arrived = !hadPassword && Boolean(pw);
      hadPassword = Boolean(pw);
      if (arrived && pw && creds?.status === undefined && this.welcomed) this.identifyNickserv(pw);
    });
  }

  // True once RPL_WELCOME arrived on this connection.
  private welcomed = false;

  // Ask the bouncer to connect / disconnect its upstream IRC network.
  // The engine reports the resulting state via `bouncer-upstream`.
  bouncerConnect(): void {
    this.onBouncerUpstreamWanted?.(true);
    this.session.bouncerConnect();
  }

  bouncerDisconnect(): void {
    this.onBouncerUpstreamWanted?.(false);
    this.session.bouncerDisconnect();
  }

  // Answer the bouncer's certificate prompt (serverInfo.bouncerCert). Trust
  // pins that exact fingerprint on the ZNC network and connects; Don't trust
  // stops ZNC's reconnect loop, which would otherwise re-dump the
  // certificate into ~server every few seconds.
  trustBouncerCert(): void {
    const cert = this.serverInfo.bouncerCert;
    if (!cert) return;
    this.session.raw(`PRIVMSG ${this.statusBotNick} :AddTrustedServerFingerprint ${cert.fingerprint}`);
    this.clearBouncerCert();
    this.bouncerConnect();
  }

  rejectBouncerCert(): void {
    if (!this.serverInfo.bouncerCert) return;
    this.clearBouncerCert();
    this.bouncerDisconnect();
  }

  private clearBouncerCert(): void {
    this.bouncerCertReason = undefined;
    if (!this.serverInfo.bouncerCert) return;
    const { bouncerCert: _, ...rest } = this.serverInfo;
    this.serverInfo = rest;
    this.emit();
  }

  // ZNC's *status bot, when its upstream TLS handshake fails, says
  // "Disconnected from IRC (Invalid SSL certificate: <why>). Reconnecting...",
  // dumps the certificate, then "If you trust this certificate, do /znc
  // AddTrustedServerFingerprint <sha256>". The command name isn't translated,
  // so the fingerprint line is the signal; the reason is a bonus when English.
  private statusBotNick = '*status';
  private bouncerCertReason: string | undefined;
  private noteBouncerStatus(e: IrcEvent): void {
    // The bot's nick prefix is configurable (StatusPrefix); its host isn't.
    const isStatusBot = /status$/i.test(e.From) && (e.Host === 'znc.in' || e.From.startsWith('*'));
    if (!isStatusBot) return;
    this.statusBotNick = e.From;
    const text = e.Message ?? '';
    const reason = /Invalid SSL certificate:\s*([^)]+)\)/i.exec(text);
    if (reason) {
      this.bouncerCertReason = reason[1].trim();
      return;
    }
    const fp = /AddTrustedServerFingerprint\s+((?:[0-9a-f]{2}:){31}[0-9a-f]{2})\b/i.exec(text);
    if (!fp) return;
    const fingerprint = fp[1].toLowerCase();
    const prev = this.serverInfo.bouncerCert;
    if (prev?.fingerprint === fingerprint && prev.reason === this.bouncerCertReason) return;
    this.serverInfo = { ...this.serverInfo, bouncerCert: { fingerprint, reason: this.bouncerCertReason } };
    this.emit();
  }

  detach(): void {
    this.unsubscribeEngine?.();
    this.unsubscribeEngine = null;
    this.unsubscribeCreds?.();
    this.unsubscribeCreds = null;
    this.unsubscribeChannelDirectory?.();
    this.unsubscribeChannelDirectory = null;
    // Clear any pending typing-expiry timers so we don't fire emit() into a
    // detached service. The state itself is left intact in case a caller
    // re-attaches (we don't have a use case for that today, but it's cheap).
    for (const handle of this.typingTimers.values()) clearTimeout(handle);
    this.typingTimers.clear();
    if (this.ackStallTimer) { clearTimeout(this.ackStallTimer); this.ackStallTimer = null; }
    for (const handle of this.namesRetryTimers.values()) clearTimeout(handle);
    this.namesRetryTimers.clear();
    this.namesRetryCount.clear();
    for (const t of this.loadOlderTimers.values()) clearTimeout(t);
    this.loadOlderTimers.clear();
    if (this.replyCtxTimer) { clearTimeout(this.replyCtxTimer); this.replyCtxTimer = null; }
    this.replyCtxWanted.clear();
    this.failHistoryQueries(() => true, 'Disconnected');
    for (const t of this.rejoinTimers.values()) clearTimeout(t);
    this.rejoinTimers.clear();
    if (this.preferredTimer) { clearTimeout(this.preferredTimer); this.preferredTimer = null; }
    if (this.markReadTimer) { clearTimeout(this.markReadTimer); this.markReadTimer = null; }
    this.markReadPending.clear();
    this.stopNickReclaim();
    // Drop the engine's services-framework subscription so a fresh
    // service-framework event after detach can't fire emit() against
    // a torn-down chat service.
    this.unsubscribeServices?.();
    this.unsubscribeServices = null;
    this.chanservCtl?.dispose();
    this.chanservCtl = null;
    this.unsubscribeBouncerUpstream?.();
    this.unsubscribeBouncerUpstream = null;
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

  // ChanServ (channel registration) for this connection. Null before attach.
  chanserv(): ChanServController | null { return this.chanservCtl; }

  // Our own host + services account on this server, learned from the
  // extended-join self-join echo, CHGHOST, ACCOUNT, and the 900 numeric.
  // The presence service reads this to publish our identity on the network.
  private myHost: string | undefined;
  private myAccount: string | undefined;

  selfIdentity(): { nick: string; host?: string; account?: string } {
    return { nick: this.myNick, host: this.myHost, account: this.myAccount };
  }

  // Whether we are an IRC operator on this connection. Set from numeric 381
  // (RPL_YOUREOPER) or a self user-mode grant (MODE <ournick> +o), both
  // forwarded by the engine as event.IsOper. Latches true for the session;
  // it gates the owner-only operator-management UI. NOTE: this is IRCd-oper
  // status, which on Anope is distinct from services-oper privilege — a
  // services-oper can manage OperServ without holding +o, so the UI treats
  // this as a guard rail and the captured OperServ reply is authoritative.
  private myOper = false;

  private setOper(): void {
    if (!this.myOper) { this.myOper = true; this.emit(); }
  }

  private updateSelfIdentity(host?: string, account?: string): void {
    let changed = false;
    if (host && host !== this.myHost) { this.myHost = host; changed = true; }
    // account === '' means "logged out" (explicit clear); undefined means
    // "unknown, leave as-is".
    if (account !== undefined) {
      const next = account || undefined;
      if (next !== this.myAccount) { this.myAccount = next; changed = true; }
    }
    // Re-emit so subscribers (the presence service) re-read selfIdentity().
    if (changed) this.emit();
  }

  // Update a member's host/account across every channel they're in (from
  // ACCOUNT / CHGHOST / account-tag). Emits only on a real change.
  private updateMemberField(nick: string, patch: Pick<Partial<ChatMember>, 'user' | 'hostname' | 'account' | 'realname'>): void {
    let changed = false;
    for (const ch of this.channels.values()) {
      const idx = ch.members.findIndex((m) => m.nick === nick);
      if (idx < 0) continue;
      const cur = ch.members[idx]!;
      const next = { ...cur, ...patch };
      if (next.hostname !== cur.hostname || next.account !== cur.account || next.user !== cur.user || next.realname !== cur.realname) {
        ch.members = ch.members.map((m, i) => (i === idx ? next : m));
        changed = true;
      }
    }
    if (changed) this.emit();
  }

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
  // Desktop-notification sink. DirectoryBloc wires this to the global Notifier;
  // bumpUnread calls it for every live notifiable message.
  private notifier: ((ev: NotifyEvent) => void) | null = null;
  setNotifier(fn: (ev: NotifyEvent) => void): void { this.notifier = fn; }

  setForeground(value: boolean): void {
    if (this.isForeground === value) return;
    this.isForeground = value;
    if (value && this.activeChannel) {
      this.markViewed(this.activeChannel);
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

  // Mark as read (a channel's or the server's context menu): its counters
  // go to zero and its read marker to the newest line, which reaches the
  // server (MARKREAD) and so the account's other clients.
  markRead(channel: string): void {
    if (this.clearUnread(this.channelKey(channel))) this.emit();
  }

  // Every conversation on this server.
  markAllRead(): void {
    let changed = false;
    for (const key of this.channels.keys()) changed = this.clearUnread(key) || changed;
    if (changed) this.emit();
  }

  private clearUnread(key: string): boolean {
    const ch = this.channels.get(key);
    if (!ch) return false;
    this.markViewed(key);
    if (ch.unread === 0 && ch.mentions === 0) return false;
    ch.unread = 0;
    ch.mentions = 0;
    return true;
  }

  // Actions -----------------------------------------------------------------

  // `focus: false` joins without switching to the channel (a background
  // restore must not yank the user out of the one they're reading).
  // `byUser`: the user asked for it (/join, the join box) — its JOIN gets
  // a "You joined" line; restores and a bouncer's replay don't.
  // `quiet`: a join the app made on its own (a network's default channels):
  // if the server refuses it, drop it without telling the user.
  join(channel: string, opts: { focus?: boolean; byUser?: boolean; quiet?: boolean } = {}): void {
    const name = normaliseChannel(channel);
    if (!name) return;
    const key = this.channelKey(name);
    if (opts.byUser) this.announceJoin.add(key);
    if (opts.quiet) this.quietJoins.add(key);
    else this.quietJoins.delete(key);
    if (!this.channels.has(key)) {
      // Store the channel keyed by its lowercase form so subsequent server
      // events (which may use different casing) land on the same record.
      this.channels.set(key, { name: key, messages: signal<ChatMessage[]>([]), joined: false, members: [], typing: [], unread: 0, mentions: 0, topic: '' });
    }
    // Auto-switch to the channel we just asked to join so the user sees it
    // immediately, even before the server's JOIN echo arrives. A focused
    // join is a pick: it ends any restore (restoreActiveChannel). A
    // background one doesn't take the screen while a restore is pending,
    // except for the channel being restored, which shows straight away.
    if (opts.focus !== false) {
      this.preferredActive = null;
      if (this.preferredTimer) { clearTimeout(this.preferredTimer); this.preferredTimer = null; }
      this.activeChannel = key;
    } else if (!this.activeChannel && (!this.preferredActive || this.preferredActive === key)) {
      this.activeChannel = key;
    }
    this.emit();
    this.session.join(key);
  }

  // The user picked a channel we're not in (a JOIN that never landed, or
  // was refused): ask the server again, and say how it went on the channel
  // (joinStatus) instead of quietly sitting there. A no-op for DMs, joined
  // channels, and a request already on its way.
  rejoin(channel: string): void {
    const key = this.channelKey(channel);
    const ch = this.channels.get(key);
    if (!ch || ch.joined || !/^[#&]/.test(key) || ch.joinStatus?.state === 'joining') return;
    ch.joinStatus = { state: 'joining' };
    this.announceJoin.add(key);
    this.clearRejoinTimer(key);
    this.rejoinTimers.set(key, setTimeout(() => {
      this.rejoinTimers.delete(key);
      const c = this.channels.get(key);
      if (c && !c.joined && c.joinStatus?.state === 'joining') {
        c.joinStatus = { state: 'failed', error: 'No answer from the server' };
        this.emit();
      }
    }, REJOIN_TIMEOUT_MS));
    this.emit();
    this.session.join(key);
  }

  private readonly rejoinTimers = new Map<string, ReturnType<typeof setTimeout>>();
  // Channels whose next self-JOIN is one the user asked for (join byUser,
  // rejoin): only those say "You joined".
  private readonly announceJoin = new Set<string>();
  // Joins whose refusal is only logged (join({ quiet: true })).
  private readonly quietJoins = new Set<string>();
  // The network's name for messages: the listing's name, else its NETWORK=.
  private networkLabel(): string {
    return this.serverScope?.serverName || this.serverInfo.network || '';
  }

  private clearRejoinTimer(key: string): void {
    const t = this.rejoinTimers.get(key);
    if (t) { clearTimeout(t); this.rejoinTimers.delete(key); }
  }

  part(channel: string): void {
    this.session.part(channel);
    this.removeChannel(channel);
  }

  // Change the IRC nick on this server. Exposed as a public method so
  // a settings panel / quick-action button can drive a rename without
  // going through the slash-command parser. The same end-state as
  // typing `/nick <new>` in the chat input.
  // `remember: false` for a rename that isn't the user's pick for this
  // server (following a new Boson handle).
  changeNick(nick: string, opts: { remember?: boolean } = {}): void {
    this.cmdNick(nick, opts.remember !== false);
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
    const serverId = this.serverScope?.serverId;
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
    const serverId = this.serverScope?.serverId;
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

    // Re-read: the INFO round-trip takes a second or more, and the user
    // may have saved a password meanwhile — merging into the snapshot
    // taken before the await would silently drop it.
    const current = store.get(serverId) ?? {};
    store.set(serverId, {
      ...current,
      accountName: current.accountName || info.accountName || nick,
      email: current.email || info.email,
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
    const serverId = this.serverScope?.serverId;
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
    if (this.nickClaimAPI.isEnabled && !this.nickClaimAPI.isEnabled()) return { kind: 'disabled' };

    const serverId = this.serverScope?.serverId;
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
      if (isNickClaimDisabledError(err)) {
        this.nickClaimAPI.onDisabled?.();
        return { kind: 'disabled' };
      }
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
    const result = fw === 'atheme'
      ? await this.getAthemeAccountService().drop(accountName, password)
      : fw === 'ergo'
        ? await this.getErgoAccountService().drop(accountName, password)
        // Anope + null + 'unknown' all route to the Anope impl as the
        // safe default.
        : await this.getAnopeAccountService().drop(accountName, password);
    // The account is gone: forget its password so the next connect doesn't
    // auto-IDENTIFY into a void. The passive classifier does the same on a
    // "has been dropped" NOTICE, but not every drop ends with one (ergo
    // disconnects a client that unregisters the account it's logged into).
    const serverId = this.serverScope?.serverId;
    if (result.kind === 'dropped' && serverId) {
      const store = getServiceCredentialsStore();
      store.set(serverId, { accountName: store.get(serverId)?.accountName, status: 'no-account' });
    }
    return result;
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

  send(channel: string, message: string, opts: SendOptions = {}): void {
    // Whitespace-only is nothing to send, except BLANK_LINE: a paste's blank
    // line (see input()).
    if (!message.trim() && message !== BLANK_LINE) return;
    const id = this.id();
    // A reply carries the msgid it answers, only where the server relays
    // client tags. Either way its text starts with who it answers (`nick: `
    // or `nick: "quote..." `), for every client that doesn't read the tag.
    const replyTo = opts.replyTo && this.repliesSupported() ? opts.replyTo : undefined;
    const target = this.replyTarget(channel, opts);
    if (target && message !== BLANK_LINE && !this.isServiceTarget(channel) && !addresses(message, target.from)) {
      message = replyPrefix(target, this.channels.get(this.channelKey(channel))?.messages.peek() ?? []) + message;
    }
    // A password typed to a service (IDENTIFY …) is shown masked; the real
    // line is kept aside for a resend.
    const shown = this.isServiceTarget(channel) ? maskServiceSecret(channel, message) : message;
    if (shown !== message) this.secretLines.set(id, message);
    // Optimistic local echo — IRC doesn't reflect our own PRIVMSGs back —
    // marked pending until the server confirms it.
    this.appendMessage(channel, {
      id,
      kind: 'message',
      from: this.myNick,
      text: shown,
      timestamp: Date.now(),
      pending: true,
      ...(replyTo ? { replyTo } : {}),
      ...(target ? { replyToId: target.id } : {}),
    });
    // Sent while a reconnect is still under way, it goes nowhere; it stays
    // pending and resendPending sends it once registered / rejoined.
    this.sendTracked(this.channelKey(channel), id, message, replyTo);
  }

  // ---- echo-message ---------------------------------------------------
  //
  // With IRCv3 echo-message the server sends each of our lines back, with
  // its msgid and server time. We still show a line the moment it's sent
  // (the local copy); its echo then gives that copy the msgid (so it can be
  // replied to, and replies to it find it) instead of adding a second line.
  //
  // Matching: every line we send waits in `awaitingEcho` (conversation, kind,
  // text), and an echo takes the oldest waiting entry with the same
  // conversation + text — lines to one target reach the server, and come
  // back, in the order sent, so FIFO pairs them even when the same text was
  // sent twice in a row. (labeled-response would pair them by label, but
  // needs a label on every line through the engine's send queue and its
  // coalescing; the order is already guaranteed per target.) A long line the
  // engine split comes back in parts: the first part matches the start of
  // the waiting text and takes the msgid, the rest are swallowed.
  //
  // An echo nothing waits for was sent from elsewhere — another device on
  // the same bouncer account — and is shown once, as ours (msgid dedupe).
  // Lines to services (NickServ IDENTIFY …), bouncer modules and CTCP other
  // than ACTION never get a line of their own.
  private awaitingEcho: Array<{ key: string; id: string; kind: ChatMessageKind; text: string; at: number; offset: number }> = [];

  private echoEnabled(): boolean {
    return (this.serverInfo.enabledCaps ?? []).includes('echo-message');
  }

  private awaitEcho(key: string, id: string, kind: ChatMessageKind, text: string): void {
    if (!this.echoEnabled()) return;
    const now = Date.now();
    // A resend replaces the entry of the send that never came back.
    this.awaitingEcho = this.awaitingEcho.filter((a) => a.id !== id && now - a.at < ECHO_WAIT_MS);
    this.awaitingEcho.push({ key, id, kind, text, at: now, offset: 0 });
  }

  private handleOwnEcho(e: IrcEvent): void {
    const t = e.Target!;
    const isChannel = t.startsWith('#') || t.startsWith('&');
    let kind: ChatMessageKind = e.Kind === 'NOTICE' ? 'notice' : 'message';
    let text = e.Message ?? '';
    const ctcp = parseCtcp(text);
    if (ctcp) {
      // CTCP requests and replies (VERSION, PING, the engine's answers) are
      // machine talk: nothing to show. ACTION is `/me`.
      if (ctcp.command !== 'ACTION' || e.Kind === 'NOTICE') return;
      kind = 'action';
      text = ctcp.args;
    }
    if (this.matchEcho(t, kind, text, e)) return;
    // Commands to services and bouncer modules have no conversation of
    // their own (unless one was opened: /msg NickServ … matched above).
    if (!isChannel && (isServiceSender(t) || isServerWildcardTarget(t))) return;
    // From another device: once, as ours. (A note to self comes back twice,
    // as the echo and as the delivery: same msgid, kept once.)
    this.appendMessage(t, {
      id: this.id(),
      kind,
      from: this.myNick,
      text,
      timestamp: this.timestampOf(e),
      msgid: e.Tags?.msgid,
      ...replyOf(e.Tags),
      ...this.serverTimeOf(e),
    });
  }

  // Pair an echo with the line waiting for it; true when it was one of ours.
  private matchEcho(target: string, kind: ChatMessageKind, text: string, e: IrcEvent): boolean {
    const now = Date.now();
    this.awaitingEcho = this.awaitingEcho.filter((a) => now - a.at < ECHO_WAIT_MS);
    const lower = target.toLowerCase();
    const trimEnd = (x: string): string => x.replace(/\s+$/, '');
    const want = trimEnd(text);
    const same = (a: { key: string; kind: ChatMessageKind }): boolean => a.key.toLowerCase() === lower && a.kind === kind;
    // The whole line (a blank paste line may come back trimmed)…
    let i = this.awaitingEcho.findIndex((a) => same(a) && a.offset === 0 && trimEnd(a.text) === want);
    let whole = i >= 0;
    // …or the next part of a long line the engine split.
    if (i < 0 && want.trim()) {
      i = this.awaitingEcho.findIndex((a) => {
        if (!same(a) || utf8Length(a.text) < ECHO_SPLIT_MIN_BYTES) return false;
        return a.text.slice(a.offset).trimStart().startsWith(want.trimStart());
      });
    }
    if (i < 0) return false;
    const a = this.awaitingEcho[i]!;
    if (!whole) {
      const rest = a.text.slice(a.offset);
      const skipped = rest.length - rest.trimStart().length;
      const first = a.offset === 0;
      a.offset += skipped + want.trimStart().length;
      whole = trimEnd(a.text.slice(a.offset)) === '';
      if (!first) {
        if (whole) this.awaitingEcho.splice(i, 1);
        return true;
      }
    }
    if (whole) this.awaitingEcho.splice(i, 1);
    this.adoptEcho(a.key, a.id, e);
    return true;
  }

  // The local copy takes the echo's msgid and server time; it has reached
  // the server, so it's no longer pending (a reconnect won't resend it).
  private adoptEcho(key: string, id: string, e: IrcEvent): void {
    const ch = this.channels.get(key);
    if (!ch) return;
    const msgid = e.Tags?.msgid;
    let updated: ChatMessage | null = null;
    const next = ch.messages.peek().map((m) => {
      if (m.id !== id) return m;
      const { pending: _sent, ...rest } = m;
      updated = { ...rest, ...(msgid ? { msgid } : {}), ...this.serverTimeOf(e) };
      return updated;
    });
    if (!updated) return;
    ch.messages.value = next;
    this.emit();
    // The stored copy too (same id and time: replaced, not added).
    if (this.persistMessages && this.persistence) {
      const { history, scope } = this.persistence;
      void history
        .append({ userId: scope.userId, serverId: scope.serverId, channel: key }, stripPending(updated))
        .catch(() => {});
    }
  }

  // The message a send answers, from its local id or msgid.
  private replyTarget(channel: string, opts: SendOptions): ChatMessage | undefined {
    if (!opts.replyToId && !opts.replyTo) return undefined;
    const msgs = this.channels.get(this.channelKey(channel))?.messages.peek() ?? [];
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i]!;
      if (opts.replyToId ? m.id === opts.replyToId : m.msgid === opts.replyTo) return m;
    }
    return undefined;
  }

  // A line from someone else without a reply tag, linked to what it answers
  // by its text (replies.ts): `before` is the conversation before it.
  private linkTextReply(msg: ChatMessage, before: readonly ChatMessage[]): ChatMessage {
    if (msg.replyTo || msg.replyToId || this.isMe(msg.from)) return msg;
    const link = resolveTextReply(msg, before);
    if (!link) return msg;
    return { ...msg, replyToId: link.id, ...(link.guessed ? { replyGuess: true as const } : {}) };
  }

  // Whether `m` answers one of our own lines (by tag, or by its text):
  // that's a mention, whether or not it says our nick.
  private repliesToMe(ch: InternalChannel | undefined, m: ChatMessage): boolean {
    if (!ch || (!m.replyTo && !m.replyToId) || this.isMe(m.from)) return false;
    const msgs = ch.messages.peek();
    for (let i = msgs.length - 1; i >= 0; i--) {
      const p = msgs[i]!;
      if (m.replyTo ? p.msgid === m.replyTo : p.id === m.replyToId) return sameNick(p.from, this.myNick);
    }
    return false;
  }

  // Whether a reply can be sent as a real one (IRCv3 `+draft/reply`): the
  // server negotiated `message-tags`, so it relays client-only tags.
  repliesSupported(): boolean {
    return (this.serverInfo.enabledCaps ?? []).includes('message-tags');
  }

  // ---- reactions (IRCv3 +draft/react) ----

  // Reactions need client-only tags relayed (message-tags); a message can
  // only be reacted to once it has a msgid.
  reactionsSupported(): boolean {
    return (this.serverInfo.enabledCaps ?? []).includes('message-tags');
  }

  // The conversation's reactions, by target msgid. A signal: a component
  // reading `.value` re-renders as reactions come and go.
  reactionsSignal(channel: string): Signal<ReactionLog> {
    const key = this.channelKey(channel);
    let s = this.reactionLogs.get(key);
    if (!s) { s = signal<ReactionLog>(new Map()); this.reactionLogs.set(key, s); }
    return s;
  }

  // React to a message (`on`), or take our reaction back: a TAGMSG with
  // `+draft/react` (or `+draft/unreact`) and `+draft/reply=<msgid>`. No text
  // fallback: clients without reactions just don't see them. Shown at once;
  // the echo (echo-message) only confirms it.
  react(channel: string, msg: ChatMessage, emoji: string, on = true): void {
    if (!this.reactionsSupported() || !msg.msgid || !emoji || msg.redacted) return;
    this.session.tagmsg(channel, { [on ? REACT_TAG : UNREACT_TAG]: emoji, [REPLY_TAG]: msg.msgid });
    this.applyReactionEvent(this.channelKey(channel), { target: msg.msgid, nick: this.myNick, emoji, on, at: Date.now() });
  }

  // A TAGMSG's reaction, applied to `conv`'s log. False when it carries none.
  private takeReaction(conv: string, e: IrcEvent): boolean {
    const tags = e.Tags;
    const target = replyOf(tags).replyTo;
    const r = reactionOf(tags, target);
    if (!r || !target || !e.From) return false;
    this.applyReactionEvent(this.channelKey(conv), {
      target, nick: e.From, emoji: r.emoji, on: r.on, at: this.timestampOf(e), id: tags?.msgid,
    });
    return true;
  }

  private applyReactionEvent(key: string, ev: ReactionEvent): void {
    if (this.redactedIds.get(key)?.has(ev.target)) return;
    const log = this.reactionsSignal(key);
    const next = applyReaction(log.peek().get(ev.target), ev);
    if (!next) return;
    this.setReactions(key, ev.target, next);
  }

  private mergeStoredReactions(key: string, msgid: string, stored: ChatMessage['reactions'] & object): void {
    const log = this.reactionsSignal(key);
    const next = mergeReactions(log.peek().get(msgid), stored);
    if (next) this.setReactions(key, msgid, next, false);
  }

  // Replace one message's entries; mirror them to its stored copy.
  private setReactions(key: string, msgid: string, entries: ChatMessage['reactions'] & object, persist = true): void {
    const log = this.reactionsSignal(key);
    const map = new Map(log.peek());
    if (entries.length) map.set(msgid, entries); else map.delete(msgid);
    log.value = map;
    if (persist) {
      const m = this.channels.get(key)?.messages.peek().find((x) => x.msgid === msgid);
      if (m && !m.pending) this.persistUpdate(key, m);
    }
  }

  // A message with its current reactions, for the store.
  private withReactions(key: string, m: ChatMessage): ChatMessage {
    const entries = m.msgid ? this.reactionLogs.get(key)?.peek().get(m.msgid) : undefined;
    return entries?.length ? { ...m, reactions: [...entries] } : m;
  }

  // Write a changed in-memory line over its stored row (same id + time).
  private persistUpdate(key: string, m: ChatMessage): void {
    if (!this.persistMessages || !this.persistence) return;
    const { history, scope } = this.persistence;
    const stored = { ...this.withReactions(key, stripPending(m)), id: this.storedIds.get(m.id) ?? m.id };
    void history.append({ userId: scope.userId, serverId: scope.serverId, channel: key }, stored).catch(() => {});
  }

  // ---- deleting messages (IRCv3 draft/message-redaction) ----

  // The server lets us delete messages (it may still refuse one: FAIL REDACT).
  redactionSupported(): boolean {
    return (this.serverInfo.enabledCaps ?? []).includes('draft/message-redaction');
  }

  // Ask the server to delete a message. It goes from the view when the
  // server's REDACT comes back (to everyone in the conversation, us too).
  redact(channel: string, msg: ChatMessage, reason?: string): void {
    if (!this.redactionSupported() || !msg.msgid || msg.redacted) return;
    const why = reason?.replace(/[\r\n]+/g, ' ').trim();
    this.session.raw(`REDACT ${channel} ${msg.msgid}${why ? ` :${why}` : ''}`);
  }

  // A REDACT: the message becomes a "deleted" placeholder, in memory and in
  // the store, its text gone; or, for a reaction's own TAGMSG, that
  // reaction is taken back.
  private applyRedaction(conv: string, msgid: string): void {
    const key = this.channelKey(conv);
    let set = this.redactedIds.get(key);
    if (!set) { set = new Set(); this.redactedIds.set(key, set); }
    set.add(msgid);
    const log = this.reactionLogs.get(key);
    if (log) {
      const map = new Map(log.peek());
      let changed = map.delete(msgid);
      for (const [target, entries] of map) {
        const next = redactReaction(entries, msgid);
        if (next) { map.set(target, next); changed = true; }
      }
      if (changed) log.value = map;
    }
    const ch = this.channels.get(key);
    if (!ch) return;
    let hit: ChatMessage | null = null;
    const next = ch.messages.peek().map((m) => {
      if (m.msgid !== msgid || m.redacted) return m;
      hit = redactedCopy(m);
      return hit;
    });
    if (!hit) return;
    ch.messages.value = next;
    this.emit();
    this.persistUpdate(key, hit);
  }

  // Lines coming (back) into view with deleted ones scrubbed; `persist`
  // writes the scrubbed copies over stored ones that still had the text.
  private scrubRedacted(key: string, msgs: ChatMessage[], persist = false): ChatMessage[] {
    const set = this.redactedIds.get(key);
    if (!set || set.size === 0) return msgs;
    return msgs.map((m) => {
      if (!m.msgid || m.redacted || !set.has(m.msgid)) return m;
      const r = redactedCopy(m);
      if (persist) this.persistUpdate(key, r);
      return r;
    });
  }

  // Delivery tracking. A message written to a connection that has silently
  // died (a phone that left Wi-Fi) would otherwise vanish: each send asks
  // the engine for an ACK (a PING behind it in the queue; the PONG proves
  // the server has everything before it). Unconfirmed after
  // ACK_STALL_MS → probe the connection, which drops a dead one; the
  // reconnect then resends what's still pending (resendPending).
  private ackSeq = 0;
  private unacked: Array<{ seq: number; channel: string; id: string }> = [];
  private ackStallTimer: ReturnType<typeof setTimeout> | null = null;

  private sendTracked(channel: string, id: string, text: string, replyTo?: string): void {
    this.awaitEcho(channel, id, 'message', text);
    const seq = ++this.ackSeq;
    this.unacked.push({ seq, channel, id });
    if (replyTo) this.session.privmsg(channel, text, seq, { [REPLY_TAG]: replyTo });
    else this.session.privmsg(channel, text, seq);
    // Typed by the user (the compose box, /msg): a service's replies to it
    // belong in their conversation with it.
    this.noteServiceAsk(channel, 'user');
    if (!this.ackStallTimer) {
      this.ackStallTimer = setTimeout(() => {
        this.ackStallTimer = null;
        if (this.unacked.length > 0) this.session.probe?.();
      }, ACK_STALL_MS);
    }
  }

  private confirmSent(upTo: number): void {
    const done = this.unacked.filter((u) => u.seq <= upTo);
    if (done.length === 0) return;
    this.unacked = this.unacked.filter((u) => u.seq > upTo);
    const byChannel = new Map<string, Set<string>>();
    for (const u of done) {
      if (!byChannel.has(u.channel)) byChannel.set(u.channel, new Set());
      byChannel.get(u.channel)!.add(u.id);
    }
    for (const [key, ids] of byChannel) {
      const ch = this.channels.get(key);
      if (!ch) continue;
      ch.messages.value = ch.messages.peek().map((m) => {
        if (!m.pending || !ids.has(m.id)) return m;
        const { pending: _sent, ...rest } = m;
        return rest;
      });
    }
    if (this.unacked.length === 0 && this.ackStallTimer) {
      clearTimeout(this.ackStallTimer);
      this.ackStallTimer = null;
    }
    this.emit();
  }

  // Send again what's still pending in one conversation: a channel once
  // (re)joined, DMs once registered. That's what the last connection never
  // confirmed (carried over by seedConversations), and anything typed
  // before this one could carry it (dropped: no registered connection, or
  // not in the channel yet).
  private resendPending(key: string): void {
    const ch = this.channels.get(key);
    if (!ch) return;
    this.unacked = this.unacked.filter((u) => u.channel !== key);
    for (const m of ch.messages.peek()) {
      if (!m.pending) continue;
      const real = this.secretLines.get(m.id);
      // A masked line whose real text didn't survive (a previous
      // connection's): never send the mask itself.
      if (real === undefined && m.text.includes(SECRET_MASK)) continue;
      this.sendTracked(key, m.id, real ?? m.text, m.replyTo);
    }
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
  private storeInboxEntry(from: string, body: string, kind: MemoKind, channel?: string, line?: ChatMessage): void {
    if (!body) return;
    const serverId = this.serverScope?.serverId ?? '';
    getMemoStore().append({
      serverId,
      // Prefer the human server name (passed in the persistence scope);
      // fall back to the serverId so an entry is never unattributed.
      serverName: this.serverScope?.serverName || this.serverInfo.network || serverId,
      sender: from,
      kind,
      channel,
      ...(line ? { messageId: line.id, ...(line.msgid ? { msgid: line.msgid } : {}) } : {}),
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
    const serverId = this.serverScope?.serverId;
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
        serverName: this.serverScope?.serverName || this.serverInfo.network || serverId,
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
    const serverId = this.serverScope?.serverId;
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
  //
  // A line of a multi-line paste keeps its indentation, and a blank line in
  // one arrives as a single space (IRC can't send an empty line), which is
  // sent as is so the receiver gets the paragraph break.
  input(text: string, opts: SendOptions = {}): void {
    const trimmed = text.trim();
    if (!trimmed && text !== BLANK_LINE) return;
    if (trimmed.startsWith('/') && !trimmed.startsWith('//')) {
      this.executeCommand(trimmed);
      return;
    }
    if (!this.activeChannel) {
      this.systemHere('No active channel. Use /join #channel first.');
      return;
    }
    // Allow `//foo` as an escape for a literal leading slash.
    const line = text.replace(/\s+$/, '') || BLANK_LINE;
    const payload = trimmed.startsWith('//') ? line.replace('//', '/') : line;
    this.send(this.activeChannel, payload, opts);
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
        this.typedWhois.add(args.split(/\s+/).pop()!.toLowerCase());
        return this.session.raw(`WHOIS ${args}`);
      case 'seen':
        if (!args) return this.systemHere('Usage: /seen <nick>');
        return this.printRemembered(args.split(/\s+/)[0]!, false);
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
      case 'oper':
        // Authenticate against the IRCd's oper block (pre-existing
        // password-based operators). Success comes back as numeric 381,
        // which the engine forwards as IsOper → the "Operator" badge lights.
        // The password is sent on the wire (inherent to OPER) but never
        // stored by us.
        if (!args) return this.systemHere('Usage: /oper <name> <password>');
        return this.session.raw(`OPER ${args}`);

      // Channel-operator verbs. All act on the current channel; the server is
      // authoritative on permission (we don't pre-reject client-side here —
      // the menu/modal already hide what you can't do).
      case 'kick': {
        if (!this.activeChannel) return this.systemHere('Use /kick inside a channel.');
        const sp = args.indexOf(' ');
        const nick = (sp < 0 ? args : args.slice(0, sp)).trim();
        const reason = sp < 0 ? undefined : (args.slice(sp + 1).trim() || undefined);
        if (!nick) return this.systemHere('Usage: /kick <nick> [reason]');
        return this.kick(this.activeChannel, nick, reason);
      }
      case 'ban': {
        if (!this.activeChannel) return this.systemHere('Use /ban inside a channel.');
        const arg = args.trim();
        if (!arg) return this.systemHere('Usage: /ban <nick|mask>');
        // A bare nick → nick!*@*; a value with mask chars passes through.
        return this.ban(this.activeChannel, /[!@*]/.test(arg) ? arg : banMask(arg.split(/\s+/)[0]!));
      }
      case 'unban': {
        if (!this.activeChannel) return this.systemHere('Use /unban inside a channel.');
        const arg = args.trim();
        if (!arg) return this.systemHere('Usage: /unban <mask>');
        return this.unban(this.activeChannel, /[!@*]/.test(arg) ? arg : banMask(arg.split(/\s+/)[0]!));
      }
      case 'op':      return this.cmdMemberMode('+o', args, '/op <nick>');
      case 'deop':    return this.cmdMemberMode('-o', args, '/deop <nick>');
      case 'halfop':  return this.cmdMemberMode('+h', args, '/halfop <nick>');
      case 'voice':   return this.cmdMemberMode('+v', args, '/voice <nick>');
      case 'devoice': return this.cmdMemberMode('-v', args, '/devoice <nick>');
      case 'invite': {
        const [n, c] = args.trim().split(/\s+/);
        if (!n) return this.systemHere('Usage: /invite <nick> [#channel]');
        const chan = c ?? this.activeChannel;
        if (!chan) return this.systemHere('Use /invite inside a channel, or give a #channel.');
        return this.invite(n, chan);
      }
      case 'topic': {
        if (!this.activeChannel) return this.systemHere('Use /topic inside a channel.');
        // No text → ask the server for the current topic (332/331 reply).
        if (!args) return this.session.raw(`TOPIC ${this.channelKey(this.activeChannel)}`);
        return this.setTopic(this.activeChannel, args);
      }
      case 'raw':
        // Escape hatch: power-user can send any line. No validation —
        // the daemon will reject garbage with a 4xx numeric.
        if (!args) return this.systemHere('Usage: /raw <IRC line>');
        return this.session.raw(args);

      default:      return this.systemHere(`Unknown command: /${cmd}. Try /help.`);
    }
  }

  // Shared impl for /op /deop /halfop /voice /devoice — set one member mode on
  // the active channel against the first arg nick.
  private cmdMemberMode(mode: ChannelMemberMode, args: string, usage: string): void {
    if (!this.activeChannel) return this.systemHere(`Use ${usage.split(' ')[0]} inside a channel.`);
    const nick = args.trim().split(/\s+/)[0];
    if (!nick) return this.systemHere(`Usage: ${usage}`);
    this.setMemberMode(this.activeChannel, nick, mode);
  }

  private cmdNick(args: string, remember = true): void {
    const next = args.trim().split(/\s+/)[0];
    if (!next) return this.systemHere('Usage: /nick <new-nick>');
    // We don't validate locally — IRC nick rules vary (length, charset,
    // reserved prefixes) and the server's 432/433/437 error is more
    // authoritative than anything we could re-enforce. On success the
    // NICK echo comes back as a regular event and handleEvent renames
    // the member entries across every joined channel.
    // The server's NICK answer makes it the nick remembered for this
    // server (noteOwnNickChange), so a reconnect asks for it again.
    this.wantedNick = next;
    this.userNickAsk = remember ? next : null;
    this.nickChoice?.pending?.(this.userNickAsk);
    this.stopNickReclaim();
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
    this.join(channel, { byUser: true });
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
        messages: signal<ChatMessage[]>([]),
        joined: false,
        members: [],
        typing: [],
        unread: 0,
        mentions: 0,
        topic: '',
      });
    }
    // A pick: it ends any restore (restoreActiveChannel).
    this.preferredActive = null;
    if (this.preferredTimer) { clearTimeout(this.preferredTimer); this.preferredTimer = null; }
    this.activeChannel = key;
    this.emit();
  }

  private cmdMe(args: string): void {
    if (!this.activeChannel) return this.systemHere('Use /me inside a channel.');
    if (!args.trim()) return this.systemHere('Usage: /me <action>');
    // CTCP ACTION: PRIVMSG body wrapped in \x01ACTION ...\x01
    const wrapped = `ACTION ${args}`;
    const id = this.id();
    this.session.privmsg(this.activeChannel, wrapped);
    this.appendMessage(this.activeChannel, {
      id,
      kind: 'action',
      from: this.myNick,
      text: args,
      timestamp: Date.now(),
    });
    this.awaitEcho(this.channelKey(this.activeChannel), id, 'action', args);
  }

  private cmdClear(): void {
    if (!this.activeChannel) return;
    const ch = this.channels.get(this.activeChannel);
    this.older.drop(this.activeChannel);
    this.revealed.delete(this.activeChannel);
    this.historyFloor.delete(this.activeChannel);
    if (ch) {
      ch.messages.value = [];
      ch.history = undefined;
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

  /**
   * On a fresh start, show `channel` (the one the user was last in) once
   * it's joined, rather than whichever channel joins first. Falls back to
   * the first joined channel if it hasn't joined within a few seconds (we
   * left it, or it's a conversation that won't be joined).
   */
  restoreActiveChannel(channel: string): void {
    if (this.activeChannel || !/^[#&]/.test(channel)) return;
    this.preferredActive = this.channelKey(channel);
  }

  /**
   * Still waiting to put the user back on the channel they were last in
   * (restoreActiveChannel): what's shown now is a stand-in (or nothing),
   * not a choice worth remembering for the next launch.
   */
  restoringActive(): boolean {
    return this.preferredActive !== null;
  }

  // Another channel joined first and the one to restore hasn't yet: after a
  // few seconds show that one, so the screen isn't empty. Keep waiting for
  // the restored channel behind it, though — a slow server (fakelag on a
  // dozen JOINs) or a bouncer coming onto its network can take longer than
  // that, and it still wins when it lands, unless the user has picked a
  // channel by then (setActive clears the wait). Given up on after
  // PREFERRED_ACTIVE_GIVE_UP_MS (we left it, or it won't be joined).
  private awaitPreferredActive(firstJoined: string): void {
    if (this.preferredTimer) return;
    this.preferredTimer = setTimeout(() => {
      this.preferredTimer = null;
      const preferred = this.preferredActive;
      if (!preferred) return;
      // Not setActive(): that would end the wait.
      if (!this.activeChannel) this.showChannel(firstJoined);
      this.preferredTimer = setTimeout(() => {
        this.preferredTimer = null;
        if (this.preferredActive !== preferred) return;
        this.preferredActive = null;
        // Settled: let the stand-in be remembered now.
        this.emit();
      }, PREFERRED_ACTIVE_GIVE_UP_MS);
    }, PREFERRED_ACTIVE_WAIT_MS);
  }

  setActive(channel: string | null): void {
    // Any pick, the user's or ours, settles what's shown.
    this.preferredActive = null;
    if (this.preferredTimer) { clearTimeout(this.preferredTimer); this.preferredTimer = null; }
    this.showChannel(channel);
  }

  private showChannel(channel: string | null): void {
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
      this.markViewed(key);
    }
    this.emit();
    // If the channel was joined but its NAMES haven't populated, ask the
    // engine to re-request — covers cases where the initial NAMREPLY was
    // lost (WS buffer pressure, engine restart, etc.).
    if (key) this.maybeRefreshNames(key);
  }

  // ZNC without server-time replays its buffers live-looking, framed by
  // `:***!znc@znc.in PRIVMSG <#chan|you> :Buffer Playback...` … `Playback
  // Complete.` (ZNC's default ChanBufferStart/End). Everything between the
  // markers — and the markers — is replay: quiet, like time-tagged backlog.
  // Keyed by channel, or ZNC_QUERY_PLAYBACK for the query buffers (addressed
  // to us). A lost end marker expires after ZNC_PLAYBACK_MAX_MS.
  private zncPlayback = new Map<string, number>();
  private inZncPlayback(scope: string, from: string, text: string | undefined): boolean {
    const now = Date.now();
    if (from === '***') {
      if (text === 'Buffer Playback...') { this.zncPlayback.set(scope, now); return true; }
      if (text === 'Playback Complete.') { this.zncPlayback.delete(scope); return true; }
    }
    const at = this.zncPlayback.get(scope);
    if (at === undefined) return false;
    if (now - at > ZNC_PLAYBACK_MAX_MS) { this.zncPlayback.delete(scope); return false; }
    return true;
  }

  // IRC nicks are case-insensitive (ASCII casemapping, as the services
  // helpers assume — rfc1459's []\~ folding only matters for names nobody
  // types): a bouncer or another device can echo our own line as "james"
  // while we're "James".
  private isMe(nick: string | undefined): boolean {
    return !!nick && !!this.myNick && nick.toLowerCase() === this.myNick.toLowerCase();
  }

  // ---- Read markers ----
  //
  // How far the user has read each conversation (read-markers.ts), so
  // what arrived while the app was closed still shows as unread when the
  // backlog comes in. Stamps are server-time when the server sent one (it
  // stays put across reconnects; `timestamp` is re-corrected for clock skew
  // each time), else our clock. With IRCv3 draft/read-marker the server
  // keeps them too and tells every client of the account (MARKREAD).

  private readMarkerSupported(): boolean {
    return (this.serverInfo.enabledCaps ?? []).includes('draft/read-marker');
  }

  // The conversation is on screen: the user is looking at it.
  private isViewing(key: string): boolean {
    return this.isForeground && this.activeChannel === key;
  }

  private static stampOf(m: ChatMessage): number {
    return m.serverTime ?? m.timestamp;
  }

  // Lines that count towards unread: from someone else, a real message.
  private countsAsUnread(m: ChatMessage): boolean {
    if (m.pending || this.isMe(m.from)) return false;
    if (m.kind !== 'message' && m.kind !== 'action' && m.kind !== 'notice') return false;
    return !!m.from && m.from !== '***';
  }

  // A conversation with no marker yet starts at this connection's attach:
  // everything before it is old history (as it always was), what came after
  // is new. Guessed, so a server's MARKREAD still overrides it.
  private ensureMarker(key: string): void {
    if (key === SERVICE_CHANNEL || this.readMarkers.get(key) !== undefined) return;
    const at = this.attachedAt || Date.now();
    // In the server's clock, like the stamps it's compared with.
    this.readMarkers.set(key, at + this.clockOffset);
    this.guessedMarkers.add(key);
  }

  // Unread + mentions in what's in memory after `marker`.
  private countAfter(ch: InternalChannel, marker: number): { unread: number; mentions: number } {
    const isDM = !ch.name.startsWith('#') && !ch.name.startsWith('&');
    let unread = 0;
    let mentions = 0;
    for (const m of ch.messages.peek()) {
      if (ChatService.stampOf(m) <= marker || !this.countsAsUnread(m)) continue;
      unread++;
      if (isDM || containsNickMention(m.text, this.myNick) || this.repliesToMe(ch, m)) mentions++;
    }
    return { unread, mentions };
  }

  // After backlog lands in a conversation that isn't on screen: whatever is
  // newer than its marker is unread. Only raises the counters (live lines
  // already counted are among them). No notification: it isn't new to the
  // server, only to this device. `baseline`: an attach's history batch —
  // a conversation never read before gets its marker now.
  private reconcileUnread(key: string, baseline = false): void {
    if (key === SERVICE_CHANNEL) return;
    const ch = this.channels.get(key);
    if (!ch) return;
    if (baseline) this.ensureMarker(key);
    const marker = this.readMarkers.get(key);
    if (marker === undefined) return;
    const { unread, mentions } = this.countAfter(ch, marker);
    if (unread > ch.unread) ch.unread = unread;
    if (mentions > ch.mentions) ch.mentions = mentions;
  }

  // The user has seen everything in `key` (it's open on screen): move its
  // marker to the newest line and tell the server.
  private markViewed(key: string): void {
    if (key === SERVICE_CHANNEL) return;
    const ch = this.channels.get(key);
    if (!ch) return;
    let newest: number | undefined;
    const msgs = ch.messages.peek();
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i]!;
      // Messages only: joins, parts and our own notes ("You joined …") are
      // stamped on this device's clock when they happen, not by the server.
      if (m.pending || (m.kind !== 'message' && m.kind !== 'action' && m.kind !== 'notice')) continue;
      newest = ChatService.stampOf(m);
      break;
    }
    if (newest === undefined) return;
    // A guessed marker (the attach time) gives way to what was really read.
    let moved: boolean;
    if (this.guessedMarkers.delete(key)) {
      this.readMarkers.set(key, newest);
      moved = true;
    } else {
      moved = this.readMarkers.advance(key, newest);
    }
    if (moved || (this.serverMarkers.get(key) ?? -Infinity) < newest) this.queueMarkRead(key, newest);
  }

  // Send MARKREAD for `key`, debounced: reading a busy channel moves the
  // marker on every line.
  private queueMarkRead(key: string, stamp: number): void {
    if (!this.readMarkerSupported() || !this.welcomed) return;
    if ((this.serverMarkers.get(key) ?? -Infinity) >= stamp) return;
    this.markReadPending.set(key, stamp);
    if (this.markReadTimer) return;
    this.markReadTimer = setTimeout(() => this.flushMarkRead(), ChatService.MARKREAD_DEBOUNCE_MS);
  }

  static readonly MARKREAD_DEBOUNCE_MS = 1000;

  private flushMarkRead(): void {
    this.markReadTimer = null;
    if (!this.readMarkerSupported()) { this.markReadPending.clear(); return; }
    for (const [key, stamp] of this.markReadPending) {
      if ((this.serverMarkers.get(key) ?? -Infinity) >= stamp) continue;
      this.serverMarkers.set(key, stamp);
      this.session.raw(`MARKREAD ${key} timestamp=${new Date(stamp).toISOString()}`);
    }
    this.markReadPending.clear();
  }

  // MARKREAD from the server: on join, in reply to a query, or because
  // another client of the account read the conversation.
  private handleServerMarker(target: string, param: string): void {
    const key = this.channelKey(target);
    if (key === SERVICE_CHANNEL) return;
    const value = param.startsWith('timestamp=') ? param.slice('timestamp='.length) : '';
    const stamp = value && value !== '*' ? Date.parse(value) : NaN;
    if (Number.isNaN(stamp)) {
      // The server knows nothing yet: hand it ours.
      const local = this.readMarkers.get(key);
      if (local !== undefined && !this.guessedMarkers.has(key)) this.queueMarkRead(key, local);
      return;
    }
    // What the server holds now (an older one than we sent means it never
    // stored ours).
    this.serverMarkers.set(key, stamp);
    const local = this.readMarkers.get(key);
    const guessed = this.guessedMarkers.has(key);
    if (local === undefined || guessed || stamp > local) {
      this.readMarkers.set(key, stamp);
      this.guessedMarkers.delete(key);
      const ch = this.channels.get(key);
      if (ch && !this.isViewing(key)) {
        const { unread, mentions } = this.countAfter(ch, stamp);
        ch.unread = unread;
        ch.mentions = mentions;
      }
      this.emit();
    } else if (stamp < local) {
      // We've read further than the server knows (offline, or a server that
      // only just got the cap): catch it up.
      this.queueMarkRead(key, local);
    }
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
  private bumpUnread(channel: string, from: string, text: string, notice = false, stamp?: number, replyToMe = false, line?: ChatMessage): void {
    if (this.isMe(from)) return;
    const key = this.channelKey(channel);
    // Service / server log channel never bumps — it's informational, and the
    // whole point of routing service NOTICEs there is to keep them quiet.
    if (key === SERVICE_CHANNEL) {
      this.ensureChannel(channel);
      return;
    }
    const isDM = !key.startsWith('#') && !key.startsWith('&');
    // A reply to one of our lines is a mention too (replies.ts).
    const isMention = isDM || replyToMe || containsNickMention(text, this.myNick);

    const open = this.isForeground && this.activeChannel === key;

    // Desktop notification — offered for every live message (not just the
    // ones that bump unread below), flagged with whether it's in the
    // conversation open on screen. The notifier decides from settings +
    // window state: never while the window is focused, and never for the
    // open conversation while the window is visible (even behind another
    // app) — only a minimised / hidden window gets banners for it.
    //
    // NOTICEs never raise a banner (bots, services, channel notices — by
    // convention automated, and noisy), except a notice sent to us directly
    // that names us: that's a person trying to get our attention.
    const notify = !notice || (isDM && containsNickMention(text, this.myNick));
    if (this.notifier && notify) {
      const scope = this.serverScope;
      this.notifier({
        serverId: scope?.serverId ?? '',
        serverName: scope?.serverName,
        channel: key,
        from,
        text,
        kind: isDM ? 'dm' : isMention ? 'mention' : 'message',
        open,
        ...(line ? { messageId: line.id, ...(line.msgid ? { msgid: line.msgid } : {}) } : {}),
      });
    }

    if (open) return;
    const ch = this.ensureChannel(channel);
    // A conversation never read before: start its marker now, so this line
    // (and any after it) still count as unread after a restart.
    this.ensureMarker(key);
    // A guessed marker sits at the attach time on OUR clock; a server whose
    // clock runs a little behind stamps live lines before it. Keep the
    // guess below every line counted live.
    const marker = this.readMarkers.get(key);
    if (stamp !== undefined && this.guessedMarkers.has(key) && marker !== undefined && stamp <= marker) {
      this.readMarkers.set(key, stamp - 1);
    }
    ch.unread += 1;
    if (isMention) ch.mentions += 1;
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
  private applyWhoReplies(ch: InternalChannel, replies: Map<string, WhoReply>): boolean {
    let touched = false;
    ch.members = ch.members.map((m) => {
      const r = replies.get(m.nick.toLowerCase());
      const next = r ? withWhoReply(m, r) : null;
      if (!next) return m;
      touched = true;
      return next;
    });
    return touched;
  }

  // Profiles ----------------------------------------------------------------

  /**
   * WHOIS `nick` for their profile, unless we did within the last minute
   * (or one is still out). Results land in `whois` reply by reply.
   */
  requestWhois(nick: string): void {
    const key = nick.toLowerCase();
    const cur = this.whois.peek().get(key);
    const age = cur ? Date.now() - cur.requestedAt : Infinity;
    if (cur && age < (cur.loading ? WHOIS_RETRY_MS : WHOIS_FRESH_MS)) return;
    this.setWhois(key, { nick, loading: true, requestedAt: Date.now() });
    this.session.raw(`WHOIS ${nick}`);
  }

  private setWhois(key: string, info: WhoisInfo): void {
    const next = new Map(this.whois.peek());
    next.set(key, info);
    this.whois.value = next;
  }

  private noteWhoisReply(e: IrcEvent): void {
    const args = e.Args ?? [];
    const nick = args[0];
    if (!nick) return;
    const key = nick.toLowerCase();
    const cur = this.whois.peek().get(key);
    // A /whois typed for someone who has gone: say what we remember.
    if (e.Kind === '401' && this.typedWhois.delete(key)) this.printRemembered(nick, true);
    if (e.Kind === '318') this.typedWhois.delete(key);
    if (WHOIS_ONLY_WHILE_LOADING.has(e.Kind) && !cur?.loading) return;
    // A /whois typed by hand fills a profile too.
    const base = cur ?? { nick, loading: true, requestedAt: Date.now() };
    const next = applyWhoisReply(base, e.Kind, args, e.Message ?? '');
    this.setWhois(key, next);
    // Our own WHOIS: who we're logged in as. 330 names the account; 307
    // ("is identified for this nick", Anope on Unreal/InspIRCd without
    // IRCv3 account names) means our nick is the account.
    if (this.isMe(nick)) {
      if (e.Kind === '330' && args[1]) this.updateSelfIdentity(undefined, args[1]);
      else if (e.Kind === '307' && !this.myAccount) this.updateSelfIdentity(undefined, nick);
    }
    if (e.Kind === '318' && !next.notFound && next.host) {
      // A finished WHOIS: who they are right now. No 330 means logged out.
      this.seen.note(next.nick, {
        user: next.user, host: next.host, realname: next.realname,
        account: next.account ?? null, actualHost: next.actualHost, whois: true,
      });
    }
  }

  // Lines describing what we remember of nick, for /seen and a /whois on
  // someone who has gone.
  private printRemembered(nick: string, gone: boolean): void {
    const r = this.seen.peek(nick);
    let text: string;
    if (!this.seen.recording) {
      text = gone ? `${nick} isn't on the network. (Remembering hosts is off in Settings → Content.)` : 'Remembering hosts is off (Settings → Content).';
    } else if (!r) {
      text = gone ? `${nick} isn't on the network, and Boson doesn't remember them.` : `Boson doesn't remember ${nick}.`;
    } else {
      const mask = seenMask(r);
      const parts = [`Remembered: ${r.nick}${mask ? ` (${mask})` : ''} was last seen ${describeSeen(r)}`];
      if (r.actualHost) parts.push(`real host ${r.actualHost}`);
      if (r.account) parts.push(`account ${r.account}`);
      if (r.realname) parts.push(`real name ${r.realname}`);
      if (r.prevHosts?.length) parts.push(`earlier ${r.prevHosts.join(', ')}`);
      text = `${gone ? `${r.nick} isn't on the network. ` : ''}${parts.join(' · ')}`;
    }
    this.noteHere(text);
  }

  // A system line in the open conversation that isn't saved to history
  // (local answers like /seen).
  private noteHere(text: string): void {
    const key = this.activeChannel;
    const ch = key ? this.channels.get(key) : undefined;
    if (!ch) { this.emitFeedback({ kind: 'error', text }); return; }
    ch.messages.value = [...ch.messages.peek(), { id: this.id(), kind: 'system', from: '', text, timestamp: Date.now() }];
    this.emit();
  }

  // The sender's identity for an activity line (join/part/quit/kick): the
  // prefix, topped up by what the member list knew. Empty while
  // remembering hosts is off.
  // A live event's msgid and server time, kept on the row it makes so the
  // same event replayed from history (event-playback) is recognised.
  private eventIdentity(e: IrcEvent): Pick<ChatMessage, 'msgid' | 'serverTime'> {
    return { ...(e.Tags?.msgid ? { msgid: e.Tags.msgid } : {}), ...this.serverTimeOf(e) };
  }

  private lineIdentity(e: IrcEvent, member?: ChatMember, extra?: { account?: string; realname?: string }): Pick<ChatMessage, 'user' | 'host' | 'account' | 'realname'> {
    if (!this.seen.recording) return {};
    const user = e.User || member?.user;
    const host = e.Host || member?.hostname;
    const account = extra?.account || e.Account || member?.account;
    const realname = extra?.realname || member?.realname;
    return {
      ...(user ? { user } : {}),
      ...(host ? { host } : {}),
      ...(account ? { account } : {}),
      ...(realname ? { realname } : {}),
    };
  }

  // The member record for nick in any channel (first found).
  private anyMember(nick: string): ChatMember | undefined {
    for (const ch of this.channels.values()) {
      const m = ch.members.find((x) => x.nick === nick);
      if (m) return m;
    }
    return undefined;
  }

  // Observation -------------------------------------------------------------

  getState(): ChatState {
    return {
      channels: Array.from(this.channels.values()).map((c) => ({
        ...c,
        // By reference (peek = no subscribe). NOT a clone: this is the hot path
        // that used to allocate an array per channel on every emit and thrash
        // the GC. Safe to share because every write reassigns the signal value
        // immutably (appendMessage included), so a retained snapshot's array is
        // never mutated underneath it.
        messages: c.messages.peek(),
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
      myOper: this.myOper,
      servicesFramework: this.servicesFramework,
    };
  }

  // The live message signal for a channel (or null if no such channel). The
  // reference is STABLE across emits, so a memo'd MessageList can read its
  // `.value` to subscribe to ONLY this channel's message changes — decoupling
  // message rendering from the metadata-snapshot emit storm.
  messagesSignal(channel: string): Signal<ChatMessage[]> | null {
    return this.channels.get(this.channelKey(channel))?.messages ?? null;
  }

  // The status sigil WE hold in `channel` ('' when not a member / no status).
  // Read by the UI to gate channel-operator actions.
  myPrefix(channel: string): MemberPrefix {
    const ch = this.channels.get(this.channelKey(channel));
    return ch?.members.find((m) => m.nick === this.myNick)?.prefix ?? '';
  }

  // Numeric rank of our status in `channel` (0=none … 5=founder). See prefixRank.
  myRank(channel: string): number {
    return prefixRank(this.myPrefix(channel));
  }

  // ---- Channel-operator actions ---------------------------------------
  // Each builds a raw IRC line; the server is authoritative on permissions.
  // The UI gates which of these it offers via myRank + the channel-ops helpers.

  kick(channel: string, nick: string, reason?: string): void {
    const ch = this.channelKey(channel);
    this.session.raw(reason ? `KICK ${ch} ${nick} :${reason}` : `KICK ${ch} ${nick}`);
  }

  ban(channel: string, mask: string): void {
    this.session.raw(`MODE ${this.channelKey(channel)} +b ${mask}`);
  }

  unban(channel: string, mask: string): void {
    this.session.raw(`MODE ${this.channelKey(channel)} -b ${mask}`);
  }

  // Grant/revoke a member status mode, e.g. setMemberMode('#x','bob','+o').
  setMemberMode(channel: string, nick: string, mode: ChannelMemberMode): void {
    this.session.raw(`MODE ${this.channelKey(channel)} ${mode} ${nick}`);
  }

  // Ban (by best-known mask) then kick — the menu's "Kick + Ban".
  kickBan(channel: string, nick: string, host?: string, reason?: string): void {
    this.ban(channel, banMask(nick, host));
    this.kick(channel, nick, reason);
  }

  invite(nick: string, channel: string): void {
    this.session.raw(`INVITE ${nick} ${this.channelKey(channel)}`);
  }

  setTopic(channel: string, text: string): void {
    this.session.raw(`TOPIC ${this.channelKey(channel)} :${text}`);
  }

  // Set a channel mode from a pre-composed fragment, e.g. '+m', '-i',
  // '+k secret', '+l 50', '-k', '-l'. The Channel Settings modal composes these.
  setChannelMode(channel: string, fragment: string): void {
    this.session.raw(`MODE ${this.channelKey(channel)} ${fragment}`);
  }

  // Fetch the current channel modes (→ RPL_CHANNELMODEIS 324).
  requestChannelModes(channel: string): void {
    this.session.raw(`MODE ${this.channelKey(channel)}`);
  }

  // Fetch the ban list (→ RPL_BANLIST 367* / RPL_ENDOFBANLIST 368). Flags the
  // channel as loading so the modal can show a spinner until 368 commits.
  requestBanList(channel: string): void {
    const key = this.channelKey(channel);
    const ch = this.channels.get(key);
    if (ch) { ch.banListLoading = true; this.emit(); }
    this.session.raw(`MODE ${key} +b`);
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
    // Chathistory backlog: messages tagged with an active `batch` ref are
    // buffered and inserted as a group on BATCH end — routed away from the
    // live path (no serverLog flood, no unread bump, no inbox mirror).
    if (e.Kind === 'ACK') { this.confirmSent(Number(e.Message)); return; }
    // ChanServ operations read replies first, so a reply they consume is
    // recognised by the routing below.
    if (!e.Tags?.batch) this.chanservCtl?.handleEvent(e);
    const batchRef = e.Tags?.batch;
    if (!batchRef) this.noteServerClock(e);
    if (batchRef) {
      const batch = this.batches.get(batchRef);
      if (batch) {
        // A batch nested in a history batch is part of it (the engine treats
        // its events as history too): its lines go to the same buffer.
        const ref = e.Kind === 'BATCH' ? (e.Args?.[0] ?? '') : '';
        if (ref.startsWith('+')) { this.batches.set(ref.slice(1), batch); this.nestedBatches.add(ref.slice(1)); }
        else if (ref.startsWith('-')) { this.batches.delete(ref.slice(1)); this.nestedBatches.delete(ref.slice(1)); }
        else this.bufferHistoryMessage(batch, e);
        return;
      }
      const targets = this.targetBatches.get(batchRef);
      if (targets) {
        // CHATHISTORY TARGETS <target> <timestamp>
        if (e.Kind === 'CHATHISTORY' && (e.Args?.[0] ?? '').toUpperCase() === 'TARGETS' && e.Args?.[1]) targets.push(e.Args[1]);
        return;
      }
    }
    // Capture EVERY event to the dev-tools log before kind-specific routing.
    // This is intentionally noisy — the panel exists so users / devs can see
    // exactly what the engine is forwarding during connect (NOTICE / 001 /
    // MOTD / ISUPPORT) and during normal operation.
    // Not our own lines echoed back (echo-message): that would put what we
    // sent services — IDENTIFY with a password — in the log.
    const ownEcho = (e.Kind === 'PRIVMSG' || e.Kind === 'NOTICE') && this.isMe(e.From) && this.echoEnabled();
    if (!ownEcho) this.appendServerLog({
      id: this.id(),
      kind: e.Kind,
      from: e.From,
      target: e.Target ?? '',
      message: e.Message ?? '',
      timestamp: Date.now(),
      args: e.Args,
    });
    // Latch our own IRC-operator status. The engine sets IsOper for numeric
    // 381 (no dedicated case below) and for a self user-mode grant (MODE
    // <ournick> +o). Double-check the MODE target is us so a stray flag can't
    // promote us off another user's event.
    if (e.IsOper && (e.Kind === '381' || e.Target === this.myNick)) {
      this.setOper();
    }
    // Latch ZNC detection (vendor caps / control bots) for the "via bouncer"
    // server-info badge.
    this.noteZncIfApplicable(e);
    if (e.Kind === 'CAP' && /(^|\s)soju\.im\/bouncer-networks(\s|=|$)/.test(`${e.Message ?? ''} ${(e.Args ?? []).join(' ')}`)) {
      this.nickOwnedSeen = true;
    }
    if (WHOIS_REPLIES.has(e.Kind)) this.noteWhoisReply(e);
    if (NICK_REFUSALS.has(e.Kind)) this.noteNickRefused(e);
    switch (e.Kind) {
      case 'PRIVMSG':
      case 'NOTICE': {
        if (!e.Target) return;
        // echo-message: our own line, back from the server with its msgid.
        if (this.isMe(e.From) && this.echoEnabled()) { this.handleOwnEcho(e); return; }
        const t = e.Target;
        const isToMe = this.isMe(t);
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
        // A ChanServ reply the channel-settings UI asked for (INFO lookups
        // and the like) is read there, not echoed into the Server log.
        if (!isChannel && this.chanservCtl?.claims(e)) return;
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
        // Where it goes is decided before the account-status classifier
        // runs: that can send NickServ a request of its own (INFO after an
        // identify), which mustn't claim the reply that triggered it.
        const privateTo = isChannel ? null : this.privateRoute(e, isWildcard);
        if (isNickServSender(e.From)) {
          this.maybeUpdateAccountStatus(e.Message);
        }
        this.noteBouncerStatus(e);
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
        let channel = privateTo ?? t;
        let kind: ChatMessageKind = e.Kind === 'NOTICE' ? 'notice' : 'message';
        let text = e.Message;
        // CTCP other than ACTION (VERSION / PING / TIME / CLIENTINFO … and
        // their NOTICE replies) is machine-to-machine: the engine answers the
        // requests itself. Logged quietly in ~server, never a DM tab, an
        // unread, a notification or an Inbox entry.
        const ctcp = parseCtcp(text);
        if (ctcp && ctcp.command !== 'ACTION') {
          channel = SERVICE_CHANNEL;
          kind = 'notice';
          const where = isChannel ? ` to ${t}` : '';
          text = e.Kind === 'NOTICE'
            ? `CTCP ${ctcp.command} reply from ${e.From}${ctcp.args ? `: ${ctcp.args}` : ''}`
            : `CTCP ${ctcp.command} from ${e.From}${where}${ctcp.args ? ` ${ctcp.args}` : ''}`;
        }
        const quiet = !!ctcp && ctcp.command !== 'ACTION';
        // Anyone sending a message is, by definition, active right now.
        this.touchMemberActivity(e.From, Date.now());
        // Remember who said it (live, or a bouncer replaying its buffer).
        if (e.Host && !this.isMe(e.From)) {
          this.seen.note(e.From, {
            user: e.User, host: e.Host, account: e.Account || undefined,
            channel: isChannel ? t : undefined, at: this.timestampOf(e),
          });
        }
        // account-tag keeps a talker's account fresh (and our own) for
        // presence matching — covers members who were silent at our join.
        if (e.Account) {
          if (this.isMe(e.From)) this.updateSelfIdentity(undefined, e.Account);
          else if (isChannel) this.updateMemberField(e.From, { account: e.Account });
        }
        // A real message implicitly cancels any pending `+typing=active` for
        // that nick in this channel.
        this.clearTyping(channel, e.From);
        // Detect CTCP ACTION (\x01ACTION ...\x01) — render as 'action' kind.
        if (kind === 'message' && text.startsWith('ACTION ') && text.endsWith('')) {
          text = text.slice('ACTION '.length, -1);
          kind = 'action';
        }
        // Backlog heuristic: a message whose server-time is well in the past
        // is bouncer/buffer replay (ZNC auto-playback on attach), not a live
        // arrival. Don't mark it unread, don't notify, don't mirror to the
        // Inbox — just show it in the channel with its original timestamp.
        // Only triggers when the server actually stamped a `time` tag.
        const ts = this.timestampOf(e);
        const isBacklog = (!!e.Tags?.time && ts < Date.now() - BACKLOG_AGE_MS)
          || this.inZncPlayback(isChannel ? this.channelKey(t) : ZNC_QUERY_PLAYBACK, e.From, e.Message);
        // Bump unread counters BEFORE appendMessage — appendMessage emits to
        // subscribers, and we want them to see the fresh counter state in
        // the same render cycle. Otherwise the badge lags by one message.
        // A reply (by tag, or by its text: replies.ts) is linked first, so
        // one to our own line counts as a mention.
        const lineCh = this.channels.get(this.channelKey(channel));
        const line = this.linkTextReply({
          id: this.id(),
          kind,
          from: e.From,
          text,
          timestamp: ts,
          msgid: e.Tags?.msgid,
          ...replyOf(e.Tags),
          ...this.serverTimeOf(e),
        }, lineCh?.messages.peek() ?? []);
        const replyToMe = this.repliesToMe(lineCh, line);
        if (!isBacklog && !quiet) this.bumpUnread(channel, e.From, text, e.Kind === 'NOTICE', e.Tags?.time ? eventTimestamp(e) : ts, replyToMe, line);
        this.appendMessage(channel, line);
        // Replayed while we were away (a bouncer's buffer, ZNC playback):
        // unread when newer than how far the user had read.
        if (isBacklog && !quiet) this.reconcileUnread(this.channelKey(channel));
        // Mirror real-user DMs (1:1, addressed to us, not a channel, not the
        // server-wildcard pseudo-channel, not our own echo) into the Inbox so
        // it holds everything addressed to the user. Unlike services these
        // STAY visible as a chat conversation too.
        if (!isBacklog && !quiet && isToMe && !isChannel && channel !== SERVICE_CHANNEL && !isServiceSender(e.From) && !this.isMe(e.From)) {
          this.storeInboxEntry(e.From, text, 'dm');
        }
        // Mirror channel mentions of our nick into the Inbox (Mentions tab)
        // so pings across servers collect in one place. Real channel messages
        // from someone else that name us; the source channel is carried for
        // click-through. (Our own lines never count as a mention.)
        if (!isBacklog && !quiet && isChannel && !this.isMe(e.From) && (replyToMe || containsNickMention(text, this.myNick))) {
          this.storeInboxEntry(e.From, text, 'mention', channel, line);
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
          const existed = this.channels.has(key);
          const joinedCh = this.ensureChannel(e.Target, true);
          this.quietJoins.delete(key);
          delete joinedCh.joinStatus;
          this.clearRejoinTimer(key);
          joinedCh.namesLoaded = false;
          joinedCh.whoLoaded = false;
          this.emitSelfMembership({ kind: 'join', channel: key });
          // extended-join echoes our own host + account on self-join — the
          // most reliable way to learn our cloak/account for presence.
          this.updateSelfIdentity(e.Host, e.Account);
          // Only a join the user made: not the restore on every launch, nor a
          // bouncer re-sending the JOINs for channels it has been in all
          // along (which read as "You joined" ×N on every open). A channel
          // that turns up on its own on a direct connection (a role's
          // auto-join, a SAJOIN) is new to us, so it's said too.
          if (this.announceJoin.delete(key) || (!existed && !this.bouncerConn)) {
            this.appendSystem(e.Target, `You joined ${e.Target}`);
          }
          if (this.preferredActive === key) {
            // Back on the channel the user was last in. setActive() is a
            // no-op when join() already showed it, so settle the wait here.
            if (this.activeChannel === key) {
              this.preferredActive = null;
              if (this.preferredTimer) { clearTimeout(this.preferredTimer); this.preferredTimer = null; }
            } else this.setActive(e.Target);
          } else if (!this.activeChannel) {
            if (this.preferredActive) this.awaitPreferredActive(e.Target);
            else this.setActive(e.Target);
          }
          this.resendPending(key);
          // Safety net: if NAMREPLY/ENDOFNAMES never arrive (e.g. drop on
          // the WS), this re-issues NAMES after a short delay.
          setTimeout(() => this.maybeRefreshNames(key), 2500);
          // Pull recent backlog once per channel open — via IRCv3 chathistory,
          // or ZNC's znc.in/playback module. Delivered as a server-time-tagged
          // BATCH and inserted as quiet backlog.
          this.requestBacklog(e.Target);
        } else {
          // Track the joiner in the channel's member list (no prefix sigil yet).
          // extended-join + the source host populate account/hostname so the
          // member can be matched to a Boson account.
          const ch = this.channels.get(key);
          this.seen.note(e.From, {
            user: e.User, host: e.Host, account: e.Account || undefined,
            realname: e.Message || undefined, channel: e.Target,
          });
          if (ch && !ch.members.some((m) => m.nick === e.From)) {
            ch.members = [...ch.members, {
              nick: e.From, prefix: '', joinedAt: Date.now(),
              ...(e.User ? { user: e.User } : {}),
              ...(e.Host ? { hostname: e.Host } : {}),
              ...(e.Account ? { account: e.Account } : {}),
              // extended-join carries the realname as the trailing param.
              ...(e.Message ? { realname: e.Message } : {}),
            }];
          }
          this.appendMessage(e.Target, {
            id: this.id(),
            kind: 'join',
            from: e.From,
            text: `${e.From} joined`,
            timestamp: Date.now(),
            ...this.eventIdentity(e),
            ...this.lineIdentity(e, undefined, { realname: e.Message || undefined }),
          });
        }
        break;
      }
      case 'ACCOUNT': {
        // account-notify: a user logged in (Account set) or out (empty).
        // Keep the account live for presence matching.
        if (e.From === this.myNick) { this.updateSelfIdentity(undefined, e.Account ?? ''); break; }
        this.updateMemberField(e.From, { account: e.Account || undefined });
        this.seen.note(e.From, { account: e.Account || null, ...(e.Host ? { user: e.User, host: e.Host } : {}) });
        break;
      }
      case 'CHGHOST': {
        // Host changed (cloak grant / vhost). Track for self + the member.
        if (e.From === this.myNick) { this.updateSelfIdentity(e.Host, undefined); break; }
        if (e.Host) {
          this.updateMemberField(e.From, { hostname: e.Host, ...(e.User ? { user: e.User } : {}) });
          this.seen.note(e.From, { host: e.Host, ...(e.User ? { user: e.User } : {}) });
        }
        break;
      }
      case 'SETNAME': {
        // setname: a user changed their realname.
        if (e.From && e.From !== this.myNick) {
          this.updateMemberField(e.From, { realname: e.Message || undefined });
          if (e.Message) this.seen.note(e.From, { realname: e.Message, ...(e.Host ? { user: e.User, host: e.Host } : {}) });
        }
        break;
      }
      case 'MARKREAD': {
        // draft/read-marker: MARKREAD <target> timestamp=<ts|*>
        if (e.Target) this.handleServerMarker(e.Target, e.Message ?? '');
        break;
      }
      case 'BATCH': {
        // Backlog framing: `BATCH +<ref> <type> <target>` opens a group;
        // `BATCH -<ref>` closes it → flush the buffer. We treat both IRCv3
        // chathistory and ZNC's `znc.in/playback` batches as backlog.
        const args = e.Args ?? [];
        const ref = args[0] ?? '';
        if (ref.startsWith('+')) {
          const type = args[1] ?? '';
          const target = args[2] ?? '';
          if (type === 'chathistory' || type === 'draft/chathistory' || type === 'znc.in/playback') {
            const query = this.takeHistoryQuery(target);
            if (query) {
              this.batches.set(ref.slice(1), { target, kind: 'query', msgs: [], query });
            } else {
              const kind = this.pendingHistoryKind.get(this.channelKey(target)) ?? 'latest';
              this.batches.set(ref.slice(1), { target, kind, msgs: [] });
            }
          } else if (type === 'chathistory-targets' || type === 'draft/chathistory-targets') {
            this.targetBatches.set(ref.slice(1), []);
          }
        } else if (ref.startsWith('-')) {
          if (this.nestedBatches.delete(ref.slice(1))) { this.batches.delete(ref.slice(1)); break; }
          const batch = this.batches.get(ref.slice(1));
          if (batch) {
            this.batches.delete(ref.slice(1));
            if (batch.query) {
              const page: HistoryPage = [...batch.msgs].sort((a, b) => a.timestamp - b.timestamp);
              page.received = batch.received ?? batch.msgs.length;
              if (batch.oldest !== undefined) page.oldest = batch.oldest;
              this.settleHistoryQuery(batch.query, page);
            }
            else this.flushHistoryBatch(batch);
          }
          const targets = this.targetBatches.get(ref.slice(1));
          if (targets) { this.targetBatches.delete(ref.slice(1)); this.requestTargetsBacklog(targets); }
        }
        break;
      }
      case '471':   // ERR_CHANNELISFULL  (+l)
      case '473':   // ERR_INVITEONLYCHAN (+i)
      case '474':   // ERR_BANNEDFROMCHAN (+b)
      case '475':   // ERR_BADCHANNELKEY  (+k)
      case '403':   // ERR_NOSUCHCHANNEL
      case '405':   // ERR_TOOMANYCHANNELS
      case '477':   // ERR_NEEDREGGEDNICK
      case '489': { // ERR_SECUREONLYCHAN
        // A /join the server refused. join() already created (and switched
        // to) the channel optimistically; drop that placeholder so it doesn't
        // sit in the sidebar as an empty channel we're not in, and tell the
        // user why. The engine passes numerics through as Args = [channel],
        // Message = the server's reason.
        const chan = e.Args?.[0] ?? e.Target ?? '';
        if (!chan.startsWith('#') && !chan.startsWith('&')) break;
        const ch = this.channels.get(this.channelKey(chan));
        // One of the network's default channels the app joined on its own:
        // not something the user asked for, so no error for it.
        if (this.quietJoins.delete(this.channelKey(chan))) {
          console.info(`[chat] auto-join of ${chan} refused (${e.Kind}): ${e.Message ?? ''}`);
          if (ch && !ch.joined) this.removeChannel(chan);
          break;
        }
        const reason = joinRefusalText(chan, e.Kind, e.Message, this.networkLabel());
        // A rejoin the user asked for on a listed channel: keep it, with
        // the reason on it (they can try again from there).
        if (ch && !ch.joined && ch.joinStatus) {
          this.clearRejoinTimer(this.channelKey(chan));
          ch.joinStatus = { state: 'failed', error: reason ?? (e.Message || 'Refused by the server') };
          this.emit();
          break;
        }
        // Not a join we're waiting on (a 403 for some other command): leave it.
        if (e.Kind === '403' && (!ch || ch.joined)) break;
        if (ch && !ch.joined) this.removeChannel(chan);
        this.emitFeedback({ kind: 'error', text: reason ?? `Cannot join ${chan}: ${e.Message || 'refused by the server'}` });
        break;
      }
      case 'FAIL': {
        // A CHATHISTORY request refused (FAIL CHATHISTORY <code> … <target>
        // :<why>): a search's request for that target gives up.
        if ((e.Args?.[0] ?? '').toUpperCase() === 'CHATHISTORY') {
          const args = new Set((e.Args ?? []).map((a) => a.toLowerCase()));
          this.failHistoryQueries((q) => args.has(q.target), e.Message || 'The server refused the history request');
        }
        // A deletion refused (FAIL REDACT <code> <target> <msgid> :<why>).
        if ((e.Args?.[0] ?? '').toUpperCase() === 'REDACT') {
          this.emitFeedback({ kind: 'error', text: redactFailText(e.Args?.[1] ?? '', e.Message) });
        }
        break;
      }
      case 'REDACT': {
        // IRCv3 draft/message-redaction: REDACT <target> <msgid> [:reason],
        // from the author or someone allowed to (a channel op, an oper).
        const msgid = e.Args?.[0];
        if (!e.Target || !msgid) break;
        this.applyRedaction(this.isMe(e.Target) ? e.From : e.Target, msgid);
        break;
      }
      case '421': {
        // ERR_UNKNOWNCOMMAND. If it's for CHATHISTORY, the server advertised
        // the cap but doesn't implement the command (e.g. ZNC < 1.8 relaying
        // it upstream) — stop trying, and settle any in-flight scroll-back.
        if ((e.Args?.[0] ?? '').toUpperCase() === 'CHATHISTORY') {
          this.chathistoryUnsupported = true;
          for (const ch of this.channels.values()) {
            if (ch.history?.loading) ch.history = { loading: false, exhausted: true };
          }
          this.failHistoryQueries(() => true, 'This server does not support CHATHISTORY');
          this.emit();
        }
        break;
      }
      case 'PART': {
        if (!e.Target) return;
        const key = this.channelKey(e.Target);
        // Our own part, from this client or another one on the same
        // bouncer (whose nick case may differ).
        if (this.isMe(e.From)) {
          this.removeChannel(e.Target);
          this.emitSelfMembership({ kind: 'part', channel: key });
        } else {
          const ch = this.channels.get(key);
          const member = ch?.members.find((m) => m.nick === e.From);
          if (ch) ch.members = ch.members.filter((m) => m.nick !== e.From);
          this.seen.note(e.From, { user: e.User || member?.user, host: e.Host || member?.hostname, channel: e.Target });
          this.appendMessage(e.Target, {
            id: this.id(),
            kind: 'part',
            from: e.From,
            text: `${e.From} left`,
            timestamp: Date.now(),
            ...this.eventIdentity(e),
            ...this.lineIdentity(e, member),
          });
        }
        break;
      }
      case 'KICK': {
        if (!e.Target) return;
        const kicked = e.Args?.[0];
        if (!kicked) break;
        const key = this.channelKey(e.Target);
        if (this.isMe(kicked)) {
          // We were the one kicked — drop the channel entirely.
          this.removeChannel(e.Target);
          this.emitSelfMembership({ kind: 'kick', channel: key });
        } else {
          const ch = this.channels.get(key);
          const member = ch?.members.find((m) => m.nick === kicked);
          if (ch) ch.members = ch.members.filter((m) => m.nick !== kicked);
          if (e.Host) this.seen.note(e.From, { user: e.User, host: e.Host, channel: e.Target });
          // The kicked nick: what the member list knew of them.
          this.seen.note(kicked, {
            user: member?.user, host: member?.hostname, account: member?.account,
            realname: member?.realname, channel: e.Target,
          });
          this.appendMessage(e.Target, {
            ...this.lineIdentity(e, ch?.members.find((m) => m.nick === e.From)),
            id: this.id(),
            kind: 'kick',
            from: e.From,
            text: `${e.From} kicked ${kicked}${e.Message ? ` (${e.Message})` : ''}`,
            timestamp: Date.now(),
            ...this.eventIdentity(e),
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
          text: modeChangeText(e.From, args),
          timestamp: Date.now(),
          ...this.eventIdentity(e),
        });
        break;
      }
      case '324': {
        // RPL_CHANNELMODEIS — channel mode snapshot. The engine's generic
        // numeric passthrough does NOT set Target, so the channel is Args[0],
        // the modestring Args[1], and any params Args[2:].
        const args = e.Args ?? [];
        const chan = args[0];
        if (!chan) break;
        const ch = this.ensureChannel(chan);
        ch.modes = { flags: [] }; // authoritative reset, then re-apply
        this.applyChannelMode(chan, args[1] ?? '', args.slice(2));
        break;
      }
      case '367': {
        // RPL_BANLIST — Args = [#chan, mask, setBy?, ts?]. Buffer until 368.
        const args = e.Args ?? [];
        const chan = args[0];
        const mask = args[1];
        if (!chan || !mask) break;
        const k = this.channelKey(chan);
        const entry: ChannelListEntry = { mask };
        if (args[2]) entry.setBy = args[2];
        const ts = Number.parseInt(args[3] ?? '', 10);
        if (Number.isFinite(ts)) entry.setAt = ts * 1000;
        const buf = this.pendingBans.get(k) ?? [];
        buf.push(entry);
        this.pendingBans.set(k, buf);
        break;
      }
      case '368': {
        // RPL_ENDOFBANLIST — commit the buffered list (possibly empty).
        const args = e.Args ?? [];
        const chan = args[0];
        if (!chan) break;
        const k = this.channelKey(chan);
        const ch = this.channels.get(k);
        if (ch) {
          ch.bans = this.pendingBans.get(k) ?? [];
          ch.banListLoading = false;
          this.emit();
        }
        this.pendingBans.delete(k);
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
        {
          const member = this.anyMember(e.From);
          this.seen.note(e.From, { user: e.User || member?.user, host: e.Host || member?.hostname });
        }
        this.nickFreed(e.From);
        this.channels.forEach((c) => {
          const member = c.members.find((m) => m.nick === e.From);
          c.members = c.members.filter((m) => m.nick !== e.From);
          if (!member) return;
          const quitMsg: ChatMessage = {
            id: this.id(),
            kind: 'quit',
            from: e.From,
            text: `${e.From} quit${e.Message ? ` (${e.Message})` : ''}`,
            timestamp: Date.now(),
            ...this.eventIdentity(e),
            ...this.lineIdentity(e, member),
          };
          c.messages.value = [...c.messages.peek(), quitMsg];
          // Mirror QUIT into persistence too — historically the only kind of
          // message that bypassed appendMessage(). Keeps cross-channel quits
          // intact across restart. Skipped on bouncer connections.
          if (this.persistMessages && this.persistence) {
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
        if (e.From !== this.myNick) {
          this.seen.rename(e.From, newNick);
          if (e.Host) this.seen.note(newNick, { user: e.User, host: e.Host });
        }
        this.channels.forEach((c) => {
          c.members = c.members.map((m) => (m.nick === e.From ? { ...m, nick: newNick } : m));
        });
        if (e.From === this.myNick) {
          const hadWanted = this.hasWantedNick();
          this.myNick = newNick;
          this.noteOwnNickChange(newNick, hadWanted);
          if (this.reclaimNoted && this.hasWantedNick()) this.noteHere(`You're “${newNick}” again.`);
          if (this.hasWantedNick()) this.stopNickReclaim();
        } else if (this.isRegistrationNickEcho(e.From, newNick)) {
          this.nickOwnedSeen = true;
          this.stopNickReclaim();
          if (!this.userNickAsk) this.takeServerNick();
        } else {
          this.nickFreed(e.From);
        }
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
          ch.namesLoaded = true;
          // userhost-in-names: everyone's mask, at once.
          for (const m of ch.members) {
            if (m.hostname && m.nick !== this.myNick) this.seen.note(m.nick, { user: m.user, host: m.hostname, channel: ch.name });
          }
          const pendingWho = this.pendingWhoReplies.get(key);
          if (pendingWho && pendingWho.size > 0) {
            this.applyWhoReplies(ch, pendingWho);
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
          const note = topicChangeText(e.From, e.Message ?? '');
          ch.messages.value = [
            ...ch.messages.peek(),
            { id: crypto.randomUUID(), kind: 'system', from: '', text: note, timestamp: Date.now(), ...this.eventIdentity(e) },
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
        //      pendingWhoReplies so 366 picks it up.
        //
        // Each line also carries the member's mask, server and realname
        // (Args[1] = server; Message = "<hopcount> <realname>").
        if (!e.Target || !e.From) return;
        const key = this.channelKey(e.Target);
        const nickLower = e.From.toLowerCase();
        const pending = this.pendingWhoReplies.get(key) ?? new Map<string, WhoReply>();
        const reply: WhoReply = {
          flags: (e.Args ?? [])[0] ?? '',
          user: e.User || undefined,
          host: e.Host || undefined,
          server: (e.Args ?? [])[1] || undefined,
          realname: (e.Message ?? '').replace(/^\d+\s?/, '') || undefined,
        };
        pending.set(nickLower, reply);
        this.pendingWhoReplies.set(key, pending);
        if (reply.host && e.From !== this.myNick) {
          this.seen.note(e.From, { user: reply.user, host: reply.host, realname: reply.realname, channel: e.Target });
        }
        // Only this line's member: a big channel's WHO is thousands of
        // lines, and a pass over the whole list per line stalls the app
        // long enough for a bouncer to drop us for not reading.
        const ch = this.channels.get(key);
        if (ch && ch.members.length > 0) {
          // Exact first: servers mostly spell a nick the same in NAMES and
          // WHO, and comparing as-is skips lowercasing every member.
          let idx = ch.members.findIndex((m) => m.nick === e.From);
          if (idx < 0) idx = ch.members.findIndex((m) => m.nick.toLowerCase() === nickLower);
          const next = idx < 0 ? null : withWhoReply(ch.members[idx]!, reply);
          if (next) {
            ch.members = ch.members.slice();
            ch.members[idx] = next;
            this.emit();
          }
        }
        break;
      }
      case '315': {
        // RPL_ENDOFWHO — the WHO the engine sends on self-join is done, so
        // members' away status is known: the channel is fully loaded.
        if (!e.Target) return;
        const ch = this.channels.get(this.channelKey(e.Target));
        if (ch && ch.joined && !ch.whoLoaded) {
          ch.whoLoaded = true;
          this.emit();
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
        ch.messages.value = [
          ...ch.messages.peek(),
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
        // The engine's own traffic on welcome (auto-IDENTIFY, the services
        // probe): what these services say next isn't for a conversation.
        for (const svc of ['NickServ', 'ChanServ', 'HostServ']) this.noteServiceAsk(svc, 'auto');
        this.welcomed = true;
        this.attachedAt = Date.now();
        this.adoptServerNick();
        this.startNickReclaim();
        // A new connection: echoes of lines sent on the last one won't come
        // (what's still pending is resent, and waits again).
        this.awaitingEcho = [];
        this.requestAttachBacklog();
        for (const key of Array.from(this.channels.keys())) {
          if (!key.startsWith('#') && !key.startsWith('&')) this.resendPending(key);
        }
        // A password that arrived between connect and welcome (see
        // watchLatePassword) — the engine wasn't given it, so send it now.
        if (!this.passwordAtConnect) {
          const serverId = this.serverScope?.serverId;
          const creds = serverId ? getServiceCredentialsStore().get(serverId) : undefined;
          if (creds?.nickservPassword && creds.status === undefined) this.identifyNickserv(creds.nickservPassword);
        }
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
        this.chanservCtl?.updateSignals();
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
        // Our account, for ChanServ (founder checks, who may register).
        const loggedInAs = e.Args?.[1] || e.Message?.match(/logged in as (\S+?)\.?$/i)?.[1];
        if (loggedInAs) this.updateSelfIdentity(undefined, loggedInAs);
        const serverId = this.serverScope?.serverId;
        if (!serverId) break;
        const store = getServiceCredentialsStore();
        const existing = store.get(serverId) ?? {};
        if (existing.status !== 'identified') {
          store.set(serverId, { ...existing, status: 'identified' });
        }
        break;
      }
      case '901': {
        // RPL_LOGGEDOUT: no account any more.
        this.updateSelfIdentity(undefined, '');
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
        // Scroll-back is live only when the server negotiated a real backlog
        // capability: IRCv3 chathistory or ZNC's znc.in/playback module.
        if (existing.has('chathistory') || existing.has('draft/chathistory') || existing.has('znc.in/playback')) {
          this.markScrollbackAvailable();
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
            this.chanservCtl?.updateSignals();
            this.emit();
          }
          if (key === 'CHATHISTORY') {
            // `CHATHISTORY=<max>` (0 = no fixed limit). The server's cap on
            // how many messages it returns per request.
            const max = Number(value);
            if (Number.isFinite(max) && max > 0 && this.serverInfo.chathistoryMax !== max) {
              this.serverInfo = { ...this.serverInfo, chathistoryMax: max };
              this.emit();
            }
          }
          if (key === 'PREFIX') {
            // e.g. "(qaohv)~&@%+" — modes and sigils positionally aligned,
            // highest-rank first. Used to decide whether to offer owner/admin
            // (+q/+a) grants. Tolerate malformed values (just skip).
            const m = /^\(([a-zA-Z]+)\)(\S+)$/.exec(value);
            if (m && m[1]!.length === m[2]!.length) {
              this.serverInfo = { ...this.serverInfo, prefix: { modes: m[1]!, sigils: m[2]! } };
              this.emit();
            }
          }
          if (key === 'CHANMODES') {
            // "A,B,C,D" = list, always-param, param-on-set, boolean. Informational.
            const [list = '', param = '', paramSet = '', bool = ''] = value.split(',');
            this.serverInfo = { ...this.serverInfo, chanModes: { list, param, paramSet, bool } };
            this.emit();
          }
        }
        break;
      }
      case 'TAGMSG': {
        // IRCv3 client-tag carrier: reactions (ours echoed back too) and
        // `+typing`. Channel or DM target lives in e.Target; nick is e.From.
        if (e.Target && e.From) {
          const conv = this.isMe(e.Target) ? e.From : e.Target;
          if (this.takeReaction(conv, e)) break;
        }
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

  private ensureChannel(name: string, joined = false): InternalChannel {
    const key = this.channelKey(name);
    let ch = this.channels.get(key);
    if (!ch) {
      ch = { name: key, messages: signal<ChatMessage[]>([]), joined, members: [], typing: [], unread: 0, mentions: 0, topic: '' };
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
    if (!this.persistMessages || !this.persistence) return;
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
        // Dedupe against what's already in memory by msgid/content (NOT just
        // id): on a server that replays its buffer (a bouncer), the same line
        // arrives live with a fresh id AND sits in persistence — id-only dedupe
        // would stack a duplicate on every reconnect.
        // Reactions kept with the stored lines go back into the log.
        for (const m of persisted) {
          if (m.msgid && m.reactions?.length) this.mergeStoredReactions(key, m.msgid, m.reactions);
        }
        const prepend = this.scrubRedacted(key, persisted
          .filter((m) => !this.isDuplicateMessage(ch, m))
          .map((m, i) => {
            const id = `${this.idSalt}-h${i}`;
            this.storedIds.set(id, m.id);
            const { reactions: _r, ...rest } = m;
            return { ...rest, id };
          }));
        if (prepend.length === 0) return;
        // Persisted messages predate anything that arrived during this session
        // for this channel, so they go first.
        // Within the conversation's window; the rest is held aside for
        // scroll-up.
        const hydrated = byTime(prepend, ch.messages.peek());
        ch.messages.value = this.windows ? this.capMessages(key, hydrated) : hydrated;
        // Lines kept on this device from last time, newer than the marker,
        // were never read (a live unread from the last run).
        if (this.isViewing(key)) this.markViewed(key);
        else this.reconcileUnread(key);
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
      // Same for chathistory: re-fetch backlog on rejoin.
      this.historyRequested.delete(key);
      this.older.drop(key);
      this.revealed.delete(key);
      this.historyFloor.delete(key);
      this.pendingHistoryKind.delete(key);
      this.pendingHistorySeq.delete(key);
      this.clearLoadOlderTimeout(key);
      if (this.activeChannel === key) {
        // Fall back to another conversation the user can see — never the
        // hidden ~server log (it isn't in the sidebar, and its composer
        // would PRIVMSG a "~server" target).
        this.activeChannel = Array.from(this.channels.keys()).find((k) => k !== SERVICE_CHANNEL) ?? null;
      }
      this.emit();
    }
  }

  // ---- Chathistory (IRCv3 backlog / scrollback) -----------------------

  // Whether the server negotiated chathistory (either cap name) AND hasn't
  // rejected a CHATHISTORY command with 421.
  chathistorySupported(): boolean {
    if (this.chathistoryUnsupported) return false;
    const caps = this.serverInfo.enabledCaps ?? [];
    return caps.includes('chathistory') || caps.includes('draft/chathistory');
  }

  private chathistoryLimit(): number {
    const max = this.serverInfo.chathistoryMax;
    return max && max > 0 ? Math.min(CHATHISTORY_REQUEST_LIMIT, max) : CHATHISTORY_REQUEST_LIMIT;
  }

  // Whether ZNC's controlled buffer-replay (znc.in/playback) is negotiated.
  // When it is, ZNC stops auto-dumping buffers and we drive replay ourselves.
  private playbackSupported(): boolean {
    return (this.serverInfo.enabledCaps ?? []).includes('znc.in/playback');
  }

  // Latch "this is a bouncer" for the server-info badge. Detected from ZNC's
  // vendor `znc.in/*` caps (advertised in CAP LS even when girc doesn't request
  // them), a CAP/message sourced from `irc.znc.in`, or a `*name` control-bot
  // sender (`*status`, `*controlpanel`, …). Display-only — scroll-back is gated
  // on the chathistory / playback capability, not on this. Idempotent.
  private zncDetected = false;
  private noteZncIfApplicable(e: IrcEvent): void {
    if (this.zncDetected) return;
    const from = e.From ?? '';
    const isZncBot = /^\*[a-zA-Z]/.test(from); // *status, *controlpanel, …
    const fromZncHost = from.includes('znc.in');
    const capText = e.Kind === 'CAP' ? `${e.Message ?? ''} ${(e.Args ?? []).join(' ')}` : '';
    // znc.in/self-message is not a ZNC signal: plain IRCds (ergo, …)
    // advertise it too.
    const advertisesZnc = /(^|\s)znc\.in\/(?!self-message(\s|=|$))/.test(capText);
    if (isZncBot || fromZncHost || advertisesZnc) {
      this.zncDetected = true;
      if (!this.serverInfo.bouncer) {
        this.serverInfo = { ...this.serverInfo, bouncer: true };
        this.emit();
      }
    }
  }

  // On every registration (a fresh attach, to a server or a bouncer), pull
  // what was said while we were away. Backlog is per attach, so what was
  // fetched last time is forgotten first; dedupe drops lines we already
  // show. Channels are fetched as their JOINs arrive (requestBacklog);
  // this adds private conversations, which have no JOIN:
  //   - chathistory (soju, ergo): CHATHISTORY TARGETS lists the recently
  //     active ones, then each gets a LATEST (requestTargetsBacklog).
  //   - ZNC znc.in/playback: `PLAY *` replays every buffer, channels and
  //     queries alike, one batch each.
  // A plain ZNC needs neither: it replays all its buffers on attach.
  private requestAttachBacklog(): void {
    this.historyRequested.clear();
    this.batches.clear();
    this.nestedBatches.clear();
    this.failHistoryQueries(() => true, 'Reconnected before the server answered');
    this.targetBatches.clear();
    this.playedAll = false;
    if (this.chathistorySupported()) {
      const now = Date.now();
      const from = new Date(now - DM_BACKLOG_WINDOW_MS).toISOString();
      // A little past now so a line stamped by a fast server clock counts.
      const to = new Date(now + 60_000).toISOString();
      this.session.raw(`CHATHISTORY TARGETS timestamp=${from} timestamp=${to} ${DM_BACKLOG_MAX_TARGETS}`);
    } else if (this.playbackSupported()) {
      this.playedAll = true;
      this.session.privmsg('*playback', 'PLAY * 0');
    }
  }

  // The reply to CHATHISTORY TARGETS: fetch each private conversation's
  // backlog. Channels are left to their JOIN (one we've left stays left).
  private requestTargetsBacklog(targets: string[]): void {
    for (const t of targets) {
      if (t.startsWith('#') || t.startsWith('&') || t === '*') continue;
      if (t.toLowerCase() === this.myNick.toLowerCase()) continue;
      // Services, servers and bouncer modules: what's stored with them is
      // the app's own automatic traffic (the services probe, IDENTIFY …),
      // never a conversation to bring back.
      if (isServiceSender(t) || isServerWildcardTarget(t)) continue;
      // Ask how far it was read first (channels get theirs with the JOIN),
      // so the backlog that follows is counted against it.
      if (this.readMarkerSupported()) this.session.raw(`MARKREAD ${t}`);
      this.requestBacklog(t);
    }
  }

  // Request the most recent backlog for a channel/target, once per open.
  // Prefers IRCv3 chathistory; falls back to ZNC's znc.in/playback module
  // (`*playback PLAY <target> 0` replays that buffer from the start). No-op
  // when neither is available.
  private requestBacklog(target: string): void {
    const key = this.channelKey(target);
    if (this.historyRequested.has(key)) return;
    if (this.chathistorySupported()) {
      this.historyRequested.add(key);
      this.expectHistory(key, 'latest');
      this.session.raw(`CHATHISTORY LATEST ${target} * ${this.chathistoryLimit()}`);
    } else if (this.playbackSupported()) {
      this.historyRequested.add(key);
      // Already on its way in the attach's `PLAY *`.
      if (this.playedAll) return;
      this.expectHistory(key, 'latest');
      this.session.privmsg('*playback', `PLAY ${target} 0`);
    }
  }

  // A request for a conversation's own backlog is going out: its batch is
  // the next one for that target (unless a search asked first).
  private expectHistory(key: string, kind: 'latest' | 'before'): void {
    this.pendingHistoryKind.set(key, kind);
    this.pendingHistorySeq.set(key, ++this.historySeq);
  }

  // ---- Search's history requests ----
  //
  // The full-page search pages back through the server's history on its
  // own: each request is answered in a batch of its own, handed back to the
  // caller and kept OUT of the conversation (no unread counts, no
  // persistence, the view untouched). Only CHATHISTORY goes to the server:
  // the query itself never leaves the device.

  /** How many messages one fetchHistory request may ask for (the server's CHATHISTORY maximum, when it says). */
  historyQueryLimit(): number {
    const max = this.serverInfo.chathistoryMax;
    return max && max > 0 ? max : HISTORY_QUERY_DEFAULT_LIMIT;
  }

  /**
   * One page of `target`'s server history, oldest first: CHATHISTORY BEFORE
   * (older than `ref`) or AROUND (centred on it). Rejects without
   * CHATHISTORY, on a 421 / FAIL, a reconnect, or no answer in time.
   */
  fetchHistory(target: string, sub: 'BEFORE' | 'AROUND', ref: HistoryRef, limit: number): Promise<HistoryPage> {
    if (!this.chathistorySupported()) return Promise.reject(new Error('This server does not keep history'));
    const n = Math.max(1, Math.min(Math.floor(limit), this.historyQueryLimit()));
    const refArg = 'msgid' in ref ? `msgid=${ref.msgid}` : `timestamp=${new Date(ref.timestamp).toISOString()}`;
    const lower = target.toLowerCase();
    return new Promise<HistoryPage>((resolve, reject) => {
      const q: HistoryQuery = {
        seq: ++this.historySeq,
        target: lower,
        resolve,
        reject,
        timer: setTimeout(() => {
          this.dropHistoryQuery(q);
          reject(new Error('No response from server'));
        }, HISTORY_QUERY_TIMEOUT_MS),
      };
      const list = this.historyQueries.get(lower) ?? [];
      list.push(q);
      this.historyQueries.set(lower, list);
      this.session.raw(`CHATHISTORY ${sub} ${target} ${refArg} ${n}`);
    });
  }

  // ---- Reply context ----
  //
  // A reply whose original isn't loaded (older than what's here, from
  // before you joined): the original is asked for on its own, CHATHISTORY
  // AROUND <target> msgid=<id> 1, and kept aside for the quote (not put in
  // the conversation). Requests from one render are collected, each msgid
  // asked for once, a few at a time.

  private replyCtx = new Map<string, ChatMessage | null>();
  private replyCtxWanted = new Map<string, { target: string; msgid: string }>();
  private replyCtxBusy = new Set<string>();
  private replyCtxTimer: ReturnType<typeof setTimeout> | null = null;
  /** Bumped when a requested original arrives (or is known missing). */
  readonly replyContextVersion = signal(0);
  private static readonly REPLY_CTX_PARALLEL = 4;
  private static readonly REPLY_CTX_DELAY_MS = 30;

  private replyCtxKey(target: string, msgid: string): string {
    return `${this.channelKey(target).toLowerCase()}\u0000${msgid}`;
  }

  /**
   * The original of a reply in `target` that isn't loaded: the message,
   * null when it can't be had (no server history, or the server hasn't it),
   * undefined while it's being fetched (or not asked for yet).
   */
  replyContext(target: string, msgid: string): ChatMessage | null | undefined {
    const k = this.replyCtxKey(target, msgid);
    if (this.replyCtx.has(k)) return this.replyCtx.get(k)!;
    return this.chathistorySupported() ? undefined : null;
  }

  /** Ask the server for these originals (once each). */
  requestReplyContext(target: string, msgids: readonly string[]): void {
    if (!this.chathistorySupported()) return;
    for (const msgid of msgids) {
      const k = this.replyCtxKey(target, msgid);
      if (this.replyCtx.has(k) || this.replyCtxBusy.has(k) || this.replyCtxWanted.has(k)) continue;
      this.replyCtxWanted.set(k, { target, msgid });
    }
    if (this.replyCtxWanted.size > 0 && !this.replyCtxTimer) {
      this.replyCtxTimer = setTimeout(() => { this.replyCtxTimer = null; this.pumpReplyContext(); }, ChatService.REPLY_CTX_DELAY_MS);
    }
  }

  private pumpReplyContext(): void {
    for (const [k, { target, msgid }] of this.replyCtxWanted) {
      if (this.replyCtxBusy.size >= ChatService.REPLY_CTX_PARALLEL) return;
      this.replyCtxWanted.delete(k);
      this.replyCtxBusy.add(k);
      const done = (m: ChatMessage | null): void => {
        this.replyCtxBusy.delete(k);
        this.replyCtx.set(k, m);
        this.replyContextVersion.value++;
        this.pumpReplyContext();
      };
      this.fetchHistory(target, 'AROUND', { msgid }, 1).then(
        (msgs) => done(msgs.find((m) => m.msgid === msgid) ?? null),
        () => done(null),
      );
    }
  }

  // The search request a chathistory batch for `target` answers, if it's
  // the oldest request still waiting for that target.
  private takeHistoryQuery(target: string): HistoryQuery | undefined {
    const lower = target.toLowerCase();
    const q = this.historyQueries.get(lower)?.[0];
    if (!q) return undefined;
    const key = this.channelKey(target);
    const own = this.pendingHistoryKind.has(key) ? this.pendingHistorySeq.get(key) ?? 0 : Infinity;
    if (own < q.seq) return undefined;
    this.dropHistoryQuery(q);
    return q;
  }

  private dropHistoryQuery(q: HistoryQuery): void {
    clearTimeout(q.timer);
    const list = this.historyQueries.get(q.target);
    if (!list) return;
    const i = list.indexOf(q);
    if (i >= 0) list.splice(i, 1);
    if (list.length === 0) this.historyQueries.delete(q.target);
  }

  private settleHistoryQuery(q: HistoryQuery, msgs: HistoryPage): void {
    clearTimeout(q.timer);
    q.resolve(msgs);
  }

  private failHistoryQueries(which: (q: HistoryQuery) => boolean, reason: string): void {
    for (const list of Array.from(this.historyQueries.values())) {
      for (const q of [...list]) {
        if (!which(q)) continue;
        this.dropHistoryQuery(q);
        q.reject(new Error(reason));
      }
    }
  }

  /**
   * Put lines from search's history into the conversation (opening a
   * result there): merged in by time, without the copies already shown,
   * kept in memory while the user reads them (like a scroll-back page),
   * not counted as unread and not saved. Returns the conversation's own id
   * for `focus` (its copy there), or null when it isn't shown.
   */
  revealHistory(channel: string, msgs: readonly ChatMessage[], focus: ChatMessage): string | null {
    const key = this.channelKey(channel);
    const ch = this.channels.get(key);
    if (!ch) return null;
    const ids = new Set<string>();
    const fresh = msgs.filter((m) => {
      const id = lineIdentity(m);
      if (ids.has(id) || this.isDuplicateMessage(ch, m)) return false;
      ids.add(id);
      return true;
    }).map(stripPending);
    if (fresh.length > 0) {
      const merged = [...ch.messages.peek(), ...fresh].sort((a, b) => a.timestamp - b.timestamp);
      this.revealed.set(key, (this.revealed.get(key) ?? 0) + fresh.length);
      ch.messages.value = merged;
      this.emit();
    }
    const shown = ch.messages.peek();
    for (let i = shown.length - 1; i >= 0; i--) {
      const m = shown[i]!;
      if (m.id === focus.id) return m.id;
      if (focus.msgid && m.msgid) { if (m.msgid === focus.msgid) return m.id; continue; }
      if (m.from === focus.from && m.text === focus.text && sameTime(m, focus)) return m.id;
    }
    return null;
  }

  // Arm the scroll-back watchdog for a channel: if no flush resolves the
  // request within LOAD_OLDER_TIMEOUT_MS, surface an error in the ribbon.
  private armLoadOlderTimeout(key: string): void {
    this.clearLoadOlderTimeout(key);
    this.loadOlderTimers.set(key, setTimeout(() => {
      this.loadOlderTimers.delete(key);
      const ch = this.channels.get(key);
      if (ch?.history?.loading) {
        ch.history = { loading: false, exhausted: false, error: 'No response from server' };
        this.emit();
      }
    }, LOAD_OLDER_TIMEOUT_MS));
  }

  private clearLoadOlderTimeout(key: string): void {
    const t = this.loadOlderTimers.get(key);
    if (t) { clearTimeout(t); this.loadOlderTimers.delete(key); }
  }

  // Public: pull older messages above the current top of a channel
  // (scroll-back). Precedence — use whichever the server actually has:
  //   1. IRCv3 chathistory  → CHATHISTORY BEFORE <pivot> (paged, the gold path)
  //   2. ZNC znc.in/playback → ranged PLAY up to the oldest loaded line
  loadOlderHistory(channel: string): void {
    const key = this.channelKey(channel);
    const ch = this.channels.get(key);
    if (!ch || ch.history?.loading || ch.history?.exhausted) return;
    const first = ch.messages.peek()[0];

    // Lines that left memory come back first (IndexedDB / memory), then
    // the server's own history.
    if (this.older.has(key)) {
      this.takeOlderPage(key, ch);
      return;
    }

    if (this.chathistorySupported()) {
      if (!first) return; // nothing to anchor before yet
      // Server time (what CHATHISTORY pages by), and no later than the
      // oldest item a page has brought, shown or not.
      const pivot = new Date(Math.min(first.serverTime ?? first.timestamp, this.historyFloor.get(key) ?? Infinity)).toISOString();
      ch.history = { loading: true, exhausted: false };
      this.expectHistory(key, 'before');
      this.armLoadOlderTimeout(key);
      this.emit();
      this.session.raw(`CHATHISTORY BEFORE ${ch.name} timestamp=${pivot} ${this.chathistoryLimit()}`);
      return;
    }

    if (this.playbackSupported()) {
      if (!first) return;
      const toSec = Math.floor(first.timestamp / 1000);
      ch.history = { loading: true, exhausted: false };
      this.expectHistory(key, 'before');
      this.armLoadOlderTimeout(key);
      this.emit();
      this.session.privmsg('*playback', `PLAY ${ch.name} 0 ${toSec}`);
      return;
    }

    ch.history = { loading: false, exhausted: true };
    this.emit();
  }

  // A page of held lines back above what's shown.
  private takeOlderPage(key: string, ch: InternalChannel): void {
    const n = this.windows?.page ?? OLDER_PAGE;
    const got = this.older.takeNewest(key, n);
    const apply = (page: ChatMessage[]): void => {
      if (this.channels.get(key) !== ch) return;
      if (page.length > 0) {
        this.revealed.set(key, (this.revealed.get(key) ?? 0) + page.length);
        const shown = ch.messages.peek();
        const fresh = this.scrubRedacted(key, page.filter((m) => !this.isDuplicateMessage(ch, m)), true);
        // Merged, not just put on top: a line older than what was held may
        // have reached the conversation while the page was on its way (an
        // async store), and it belongs above it.
        ch.messages.value = byTime(fresh, shown);
      }
      // Nothing came back although the index said lines were held (an
      // IndexedDB write that failed, e.g. in a WebView): forget them, so the
      // next scroll-up goes on to the server's history instead of asking
      // the store again forever.
      if (page.length === 0) this.older.drop(key);
      const serverHistory = this.chathistorySupported() || this.playbackSupported();
      ch.history = { loading: false, exhausted: !serverHistory && !this.older.has(key) };
      this.emit();
    };
    if (Array.isArray(got)) { apply(got); return; }
    ch.history = { loading: true, exhausted: false };
    this.emit();
    void got.then(apply, () => apply([]));
  }

  // ---- memory windows ----

  // The message list reports whether the user reads at the bottom of the
  // conversation on screen. Back at the bottom, what they'd scrolled up
  // through leaves memory again.
  setViewport(channel: string, atBottom: boolean): void {
    if (!this.windows) return;
    const key = this.channelKey(channel);
    if (key !== this.visibleKey) return;
    const was = this.viewportAtBottom;
    this.viewportAtBottom = atBottom;
    if (atBottom && !was) this.trimTo(key, this.windows.active);
  }

  // The conversation on screen changed (active channel, server in front):
  // the one left goes down to a tail; the new one is filled to a window.
  private syncVisible(): void {
    if (!this.windows) return;
    const next = this.isForeground ? this.activeChannel : null;
    if (next === this.visibleKey) return;
    const prev = this.visibleKey;
    this.visibleKey = next;
    this.viewportAtBottom = true;
    if (prev) this.trimTo(prev, this.windows.tail);
    if (next) this.fillWindow(next);
  }

  private trimTo(key: string, n: number): void {
    const ch = this.channels.get(key);
    if (!ch) return;
    this.revealed.delete(key);
    const msgs = ch.messages.peek();
    if (msgs.length <= n) return;
    this.stashOlder(key, msgs.slice(0, msgs.length - n));
    ch.messages.value = msgs.slice(msgs.length - n);
    if (ch.history?.exhausted) ch.history = { loading: false, exhausted: false };
    this.emit();
  }

  // Bring the on-screen conversation back up to its window from the store.
  private fillWindow(key: string): void {
    const ch = this.channels.get(key);
    if (!ch || !this.windows) return;
    const want = this.windows.active - ch.messages.peek().length;
    if (want <= 0 || !this.older.has(key)) return;
    const got = this.older.takeNewest(key, want);
    const apply = (page: ChatMessage[]): void => {
      if (this.channels.get(key) !== ch || page.length === 0) return;
      const fresh = page.filter((m) => !this.isDuplicateMessage(ch, m));
      // Merged by time: the store answers later (IndexedDB), and an attach's
      // backlog can land first with a line older than what it holds.
      ch.messages.value = byTime(fresh, ch.messages.peek());
      this.emit();
    };
    if (Array.isArray(got)) apply(got);
    else void got.then(apply, () => {});
  }

  // The cap for key's in-memory list right now.
  private capFor(key: string, live: boolean): number {
    if (!this.windows) return IN_MEMORY_MESSAGE_CAP;
    if (key !== this.visibleKey) return this.windows.tail;
    if (this.viewportAtBottom || !live) return this.windows.active + (this.revealed.get(key) ?? 0);
    return Number.POSITIVE_INFINITY;
  }

  // Keep a conversation's newest lines within its cap (raised by what
  // scroll-up has revealed); the rest go aside into `older`. `live`: once
  // the user has scrolled back, new lines grow the cap instead of pushing
  // what they're reading off the top (up to OLDER_CAP extra).
  private capMessages(key: string, msgs: ChatMessage[], live = false): ChatMessage[] {
    let cap: number;
    if (!this.windows) {
      let extra = this.revealed.get(key) ?? 0;
      if (live && extra > 0 && msgs.length > IN_MEMORY_MESSAGE_CAP + extra) {
        extra = Math.min(OLDER_CAP, msgs.length - IN_MEMORY_MESSAGE_CAP);
        this.revealed.set(key, extra);
      }
      cap = IN_MEMORY_MESSAGE_CAP + extra;
    } else {
      cap = this.capFor(key, live);
    }
    if (msgs.length <= cap) return msgs;
    this.stashOlder(key, msgs.slice(0, msgs.length - cap));
    return msgs.slice(msgs.length - cap);
  }

  // Add lines to a conversation's `older` store (deduped there). Makes
  // scroll-up available (again).
  private stashOlder(key: string, msgs: readonly ChatMessage[]): void {
    if (msgs.length === 0) return;
    this.older.put(key, msgs.map(stripPending));
    const ch = this.channels.get(key);
    if (ch?.history?.exhausted && this.older.has(key)) {
      ch.history = { loading: false, exhausted: false };
    }
    this.markScrollbackAvailable();
  }

  // ---- Services: whose request a reply answers -------------------------
  //
  // A service conversation (@NickServ, @ChanServ …) shows what the user
  // typed to that service and its replies, like any IRC client. Everything
  // the app sends services by itself — the engine's probe and IDENTIFY on
  // welcome, account flows, ChanServ settings, MemoServ for the Inbox,
  // silent INFO lookups — stays out of it: those replies go to the quiet
  // ~server log (or the UI that asked reads them first).
  //
  // The latest request to each service decides: sendTracked (the compose
  // path, /msg) marks the user's; every other PRIVMSG through the session
  // (trackServiceSends) marks an automatic one, and so does welcome. A reply
  // goes to the conversation while the latest request was the user's and
  // it is still coming (within SERVICE_REPLY_WINDOW_MS of the last line, so
  // a long HELP keeps flowing). New automatic flows are hidden by default.
  private serviceAsks = new Map<string, { by: 'user' | 'auto'; at: number }>();
  // The real text of lines shown masked (IDENTIFY ••••••), by message id.
  private secretLines = new Map<string, string>();
  private readonly servicesVerdicts: { save(serverId: string, framework: string): void } | null;

  private isServiceTarget(target: string): boolean {
    return !/^[#&]/.test(target) && isServiceSender(target) && !isServerWildcardTarget(target);
  }

  private noteServiceAsk(target: string, by: 'user' | 'auto'): void {
    if (!this.isServiceTarget(target)) return;
    this.serviceAsks.set(this.channelKey(target), { by, at: Date.now() });
  }

  // Which conversation a private PRIVMSG / NOTICE (not to a channel) goes to.
  private privateRoute(e: IrcEvent, isWildcard: boolean): string {
    const from = e.From;
    const key = this.channelKey(from);
    if (isWildcard) return SERVICE_CHANNEL;
    if (isServiceSender(from)) {
      const ask = this.serviceAsks.get(key);
      const now = Date.now();
      if (ask?.by === 'user' && now - ask.at < SERVICE_REPLY_WINDOW_MS) {
        ask.at = now;
        // The user's conversation with it (they may have closed it since).
        this.ensureChannel(from);
        return from;
      }
      return SERVICE_CHANNEL;
    }
    // A NOTICE from someone the user has no conversation with — a bot's
    // scan, a network's announcer — isn't the start of one, unless it names
    // the user (a person trying to get their attention). A PRIVMSG is.
    if (e.Kind === 'NOTICE' && !this.channels.has(key) && !containsNickMention(e.Message ?? '', this.myNick)) {
      return SERVICE_CHANNEL;
    }
    return from;
  }

  // Buffer one message that arrived inside an active chathistory BATCH.
  private bufferHistoryMessage(
    batch: HistoryBatch,
    e: IrcEvent,
  ): void {
    // Replayed lines carry the sender's prefix too: remember it, as of then.
    if (e.Host && e.From && !this.isMe(e.From) && ['PRIVMSG', 'NOTICE', 'JOIN', 'PART', 'QUIT'].includes(e.Kind)) {
      this.seen.note(e.From, {
        user: e.User, host: e.Host, account: e.Account || undefined,
        channel: /^[#&]/.test(batch.target) ? batch.target : undefined, at: this.timestampOf(e),
      });
    }
    batch.received = (batch.received ?? 0) + 1;
    if (e.Tags?.time) {
      const t = eventTimestamp(e);
      if (batch.oldest === undefined || t < batch.oldest) batch.oldest = t;
    }
    if (e.Kind === 'TAGMSG') { this.handleHistoryTagmsg(batch, e); return; }
    if (HISTORY_EVENT_KINDS.has(e.Kind)) {
      const row = this.historyEventRow(batch.target, e);
      if (row) batch.msgs.push(row);
      return;
    }
    if (e.Kind !== 'PRIVMSG' && e.Kind !== 'NOTICE') return;
    // A server without event-playback (or before we asked for it): Ergo's
    // HistServ stand-ins for joins/quits/…, which our own rows already show.
    if (isHistServReplay(e.From, batch.target, e.Message ?? '')) return;
    let text = e.Message ?? '';
    let kind: ChatMessageKind = e.Kind === 'NOTICE' ? 'notice' : 'message';
    // CTCP other than ACTION (VERSION scans and our replies, PING …) is
    // machine talk, live or replayed: never a line.
    const ctcp = parseCtcp(text);
    if (ctcp && (ctcp.command !== 'ACTION' || e.Kind === 'NOTICE')) return;
    if (text.startsWith('ACTION ') && text.endsWith('')) {
      text = text.slice('ACTION '.length, -1);
      kind = 'action';
    }
    batch.msgs.push({
      id: this.id(),
      kind,
      from: e.From,
      text,
      timestamp: this.timestampOf(e),
      msgid: e.Tags?.msgid,
      ...replyOf(e.Tags),
      ...this.serverTimeOf(e),
    });
  }

  // A TAGMSG replayed in a history batch (event-playback). Typing
  // notifications are moot by now and show nothing; the batch's target and
  // e's tags (msgid, time, client tags) are all here for tags that do mean
  // something later (reactions hook in here).
  // A TAGMSG replayed in a history batch (event-playback): never a row; a
  // reaction goes into the log, as a live one does (newest statement wins,
  // so a replay of what we already have changes nothing).
  private handleHistoryTagmsg(batch: HistoryBatch, e: IrcEvent): void {
    this.takeReaction(batch.target, e);
  }

  // The row a history event (event-playback) makes in `target`'s backlog —
  // the same one the live event makes, at its server time — or null when the
  // live event shows none either (a nick change, our own join/part/quit).
  // Only builds a row: members, topic, nick and membership are live state
  // and stay as they are.
  private historyEventRow(target: string, e: IrcEvent): ChatMessage | null {
    if (!/^[#&]/.test(target) || !e.From) return null;
    const base = {
      id: this.id(),
      from: e.From,
      timestamp: this.timestampOf(e),
      ...(e.Tags?.msgid ? { msgid: e.Tags.msgid } : {}),
      ...this.serverTimeOf(e),
    };
    switch (e.Kind) {
      case 'JOIN':
        if (this.isMe(e.From)) return null;
        return { ...base, kind: 'join', text: `${e.From} joined`, ...this.lineIdentity(e, undefined, { realname: e.Message || undefined }) };
      case 'PART':
        if (this.isMe(e.From)) return null;
        return { ...base, kind: 'part', text: `${e.From} left`, ...this.lineIdentity(e) };
      case 'QUIT':
        if (this.isMe(e.From)) return null;
        return { ...base, kind: 'quit', text: `${e.From} quit${e.Message ? ` (${e.Message})` : ''}`, ...this.lineIdentity(e) };
      case 'KICK': {
        const kicked = e.Args?.[0];
        if (!kicked) return null;
        return { ...base, kind: 'kick', text: `${e.From} kicked ${kicked}${e.Message ? ` (${e.Message})` : ''}`, ...this.lineIdentity(e) };
      }
      case 'TOPIC':
        return { ...base, kind: 'system', from: '', text: topicChangeText(e.From, e.Message ?? '') };
      case 'MODE': {
        const args = e.Args ?? [];
        if (args.length === 0) return null;
        return { ...base, kind: 'system', from: '', text: modeChangeText(e.From, args) };
      }
      default:
        return null; // NICK: live renames show no row either
    }
  }

  // True when a history event row is already shown: the same msgid, or —
  // against a row Boson made live, which may carry no msgid and is stamped
  // with our clock — the same kind, sender and text a few seconds apart.
  private isDuplicateEvent(ch: InternalChannel, msg: ChatMessage): boolean {
    if (!EVENT_ROW_KINDS.has(msg.kind)) return false;
    const arr = ch.messages.peek();
    for (let i = arr.length - 1; i >= 0; i--) {
      const m = arr[i]!;
      if (m.kind !== msg.kind) continue;
      if (msg.msgid && m.msgid) {
        if (m.msgid === msg.msgid) return true;
        continue;
      }
      if (m.from === msg.from && m.text === msg.text && Math.abs(m.timestamp - msg.timestamp) <= EVENT_DEDUPE_WINDOW_MS) return true;
    }
    return false;
  }

  // Record how far the server's clock is from ours, from a live event.
  private noteServerClock(e: IrcEvent): void {
    const t = e.Tags?.time;
    if (!t || SKEW_SKIP_KINDS.has(e.Kind)) return;
    const ms = Date.parse(t);
    if (Number.isNaN(ms)) return;
    const now = Date.now();
    const samples = this.clockSamples.filter((x) => now - x.at < SKEW_WINDOW_MS);
    samples.push({ at: now, off: ms - now });
    this.clockSamples = samples.slice(-SKEW_MAX_SAMPLES);
    const off = Math.max(...this.clockSamples.map((x) => x.off));
    this.clockOffset = Math.abs(off) < SKEW_MIN_MS || Math.abs(off) > SKEW_MAX_MS ? 0 : off;
  }

  // A message's time on OUR clock: server-time corrected for the server's
  // measured skew, or now when the server didn't stamp it.
  private timestampOf(e: IrcEvent): number {
    return e.Tags?.time ? eventTimestamp(e) - this.clockOffset : eventTimestamp(e);
  }

  // The uncorrected server-time, as `{ serverTime }` when the event has one.
  private serverTimeOf(e: IrcEvent): { serverTime?: number } {
    return e.Tags?.time ? { serverTime: eventTimestamp(e) } : {};
  }

  // Flush a completed chathistory batch: dedupe, merge into the channel by
  // time, persist, and clear the loading flag (+ mark exhausted when the
  // server returned a short page). A scroll-back page lands above what's
  // shown; an attach's backlog can be newer than lines carried over from
  // before the reconnect, so it is merged, not just prepended.
  private flushHistoryBatch(batch: HistoryBatch): void {
    // A private conversation that only exists in the server's history as
    // NOTICEs (a bot's scans, a server's notices) isn't one: it isn't
    // brought back unless the user already has it open.
    if (!/^[#&]/.test(batch.target) && !this.channels.has(this.channelKey(batch.target))
      && !batch.msgs.some((m) => m.kind !== 'notice')) {
      this.pendingHistoryKind.delete(this.channelKey(batch.target));
      this.pendingHistorySeq.delete(this.channelKey(batch.target));
      return;
    }
    const ch = this.ensureChannel(batch.target);
    const key = this.channelKey(batch.target);
    const sorted = this.scrubRedacted(key, [...batch.msgs].sort((a, b) => a.timestamp - b.timestamp));
    // Dedupe by msgid AND content (from+text+timestamp): a server may replay
    // the same buffer on every attach with no msgid, so msgid-only dedupe lets
    // reconnect dups pile up. isDuplicateMessage covers both.
    let fresh = sorted.filter((m) => !this.isDuplicateMessage(ch, m) && !this.isDuplicateEvent(ch, m) && !this.older.contains(key, m));
    // Lines older than everything in memory while older ones are held
    // aside go with those (see belongsAbove), so scroll-up brings them back
    // in order.
    const above = fresh.filter((m) => this.belongsAbove(key, ch, m));
    if (above.length > 0) {
      this.stashOlder(key, above);
      fresh = fresh.filter((m) => !above.includes(m));
    }
    if (fresh.length > 0) {
      // Stable: among equal timestamps what was already shown stays first.
      let merged = [...ch.messages.peek(), ...fresh].sort((a, b) => a.timestamp - b.timestamp);
      // Replies by their text, against what came before each.
      const isFresh = new Set(fresh);
      const linked = new Map<ChatMessage, ChatMessage>();
      const all = merged;
      merged = all.map((m, i) => {
        if (!isFresh.has(m)) return m;
        const l = this.linkTextReply(m, all.slice(Math.max(0, i - REPLY_WINDOW), i));
        linked.set(m, l);
        return l;
      });
      fresh = fresh.map((m) => linked.get(m) ?? m);
      // An attach's backlog keeps only the newest lines, like live traffic: a
      // ZNC that doesn't clear its buffers replays all of it (10k lines per
      // channel is common) on every attach. Scroll-back pages are kept whole.
      ch.messages.value = batch.kind === 'latest' ? this.capMessages(key, merged) : merged;
    }
    // A short page means the server has nothing older. Without a history
    // command (a plain ZNC's own replay) only lines held aside remain.
    const serverHistory = this.chathistorySupported() || this.playbackSupported();
    ch.history = {
      loading: false,
      exhausted: this.older.has(key) ? false : serverHistory ? Math.max(batch.msgs.length, batch.received ?? 0) < this.chathistoryLimit() : true,
    };
    if (batch.oldest !== undefined && batch.oldest < (this.historyFloor.get(key) ?? Infinity)) this.historyFloor.set(key, batch.oldest);
    this.pendingHistoryKind.delete(key);
    this.pendingHistorySeq.delete(key);
    this.clearLoadOlderTimeout(key);
    // An attach's backlog: what arrived since the user last read it is
    // unread (or, open on screen, it's read now).
    if (batch.kind === 'latest') {
      if (this.isViewing(key)) this.markViewed(key);
      else this.reconcileUnread(key, true);
    }
    this.emit();
    // Persist the backlog so it survives reconnects / offline. Skipped on
    // bouncer connections (the bouncer is the archive; see persistMessages).
    if (this.persistMessages && this.persistence && fresh.length + above.length > 0) {
      const { history, scope } = this.persistence;
      for (const m of [...above, ...fresh]) {
        void history.append({ userId: scope.userId, serverId: scope.serverId, channel: key }, this.withReactions(key, m)).catch(() => {});
      }
    }
  }

  // Flip the per-server "scroll-back available" flag once a backlog capability
  // is confirmed (IRCv3 chathistory or ZNC's znc.in/playback). The UI shows the
  // load-older affordance off this. Idempotent; emits only on the transition.
  private markScrollbackAvailable(): void {
    if (this.serverInfo.scrollbackAvailable) return;
    this.serverInfo = { ...this.serverInfo, scrollbackAvailable: true };
    this.emit();
  }

  // True when `msg` is already present in the channel. Two copies that both
  // carry an IRCv3 msgid match on it; otherwise on sender + text + send time
  // (sameTime). Bouncer reconnects replay the same buffer with IDENTICAL
  // server-time stamps, so this collapses replay duplicates while leaving
  // genuine repeats (which carry distinct times) intact — critical for
  // servers like ngircd that don't emit msgid. Walks back-to-front since dups
  // cluster near the tail.
  private isDuplicateMessage(ch: InternalChannel, msg: ChatMessage): boolean {
    const arr = ch.messages.peek();
    for (let i = arr.length - 1; i >= 0; i--) {
      const m = arr[i]!;
      if (msg.msgid && m.msgid) {
        if (m.msgid === msg.msgid) return true;
        continue;
      }
      if (m.from === msg.from && m.text === msg.text && sameTime(m, msg)) return true;
    }
    return false;
  }

  private appendMessage(channel: string, msg: ChatMessage): void {
    const ch = this.ensureChannel(channel);
    // De-dupe (msgid or content) so live + chathistory + bouncer-replay copies
    // of the same message collapse instead of stacking up on every reconnect.
    // A line we just sent is never a copy (a paste can repeat a line within
    // the same millisecond).
    if (!msg.pending && this.isDuplicateMessage(ch, msg)) return;
    const key = this.channelKey(channel);
    // Older than everything in memory while older lines are held aside (a
    // bouncer's replay after a reconnect, a line this device never got): it
    // goes with those, not on top of what's shown, where scroll-up would
    // later put the held lines above it. Off screen, so the view stays put.
    if (!msg.pending && this.belongsAbove(key, ch, msg)) {
      if (this.older.contains(key, msg)) return;
      this.stashOlder(key, [msg]);
      this.emit();
      this.persistLine(key, msg);
      return;
    }
    // Immutable reassignment (the signal must see a new array reference to
    // notify). Insert by timestamp so out-of-order arrivals — chiefly ZNC/
    // bouncer buffer replay, whose messages carry old server-time tags — land
    // in chronological position instead of stacking at the bottom. The common
    // case (a live message newer than the last) stays a cheap push; only a
    // genuinely older arrival walks back to find its slot. Stable among equal
    // timestamps (insert after equals → preserves arrival order within a tick).
    const arr = ch.messages.peek();
    let next: ChatMessage[];
    if (arr.length === 0 || msg.timestamp >= arr[arr.length - 1]!.timestamp) {
      msg = this.linkTextReply(msg, arr);
      next = [...arr, msg];
    } else {
      let i = arr.length;
      while (i > 0 && arr[i - 1]!.timestamp > msg.timestamp) i--;
      msg = this.linkTextReply(msg, arr.slice(0, i));
      next = [...arr.slice(0, i), msg, ...arr.slice(i)];
    }
    // Bounded in-memory cap, trimmed from the front (oldest) into `older`.
    next = this.capMessages(key, next, true);
    ch.messages.value = next;
    // A line landing in the conversation on screen has been seen.
    if (this.isViewing(ch.name)) this.markViewed(ch.name);
    this.emit();
    // Mirror to persistence (fire-and-forget). The store enforces its own cap
    // so callers don't need to think about eviction. Skipped on bouncer
    // connections — the bouncer replays its own buffer, so a local copy would
    // duplicate on every reconnect.
    this.persistLine(key, msg);
  }

  private persistLine(key: string, msg: ChatMessage): void {
    if (!this.persistMessages || !this.persistence) return;
    const { history, scope } = this.persistence;
    void history
      .append({ userId: scope.userId, serverId: scope.serverId, channel: key }, this.withReactions(key, stripPending(msg)))
      .catch(() => {
        // Storage hiccup — chat keeps going with in-memory state.
      });
  }

  // True when msg is older than every line in memory while lines are held
  // aside in `older`: its place is among those, above what's shown.
  private belongsAbove(key: string, ch: InternalChannel, msg: ChatMessage): boolean {
    const first = ch.messages.peek()[0];
    return first !== undefined && msg.timestamp < first.timestamp && this.older.has(key);
  }

  // Apply a MODE change to a channel. Updates BOTH per-member status sigils
  // (~/&/@/%/+ ↔ q/a/o/h/v) AND channel-wide mode state (ch.modes: boolean
  // flags + key/limit). When the ban list has already been fetched (ch.bans
  // set), live +b/-b are applied to it too. Param cursor: status + list (b/e/I)
  // + key consume an arg on both signs; limit only on `+`; boolean flags none.
  private applyChannelMode(channel: string, modeStr: string, params: string[]): void {
    const key = this.channelKey(channel);
    const ch = this.channels.get(key);
    if (!ch) return;
    const PREFIX_OF: Record<string, MemberPrefix> = {
      q: '~', a: '&', o: '@', h: '%', v: '+',
    };
    const LIST = new Set(['b', 'e', 'I']);

    let adding = true;
    let argIdx = 0;
    let nextMembers = ch.members;
    const modes: ChannelModes = ch.modes
      ? { flags: [...ch.modes.flags], key: ch.modes.key, limit: ch.modes.limit }
      : { flags: [] };
    let bans = ch.bans;
    let memberChanged = false;
    let modeChanged = false;
    let banChanged = false;

    for (const c of modeStr) {
      if (c === '+') { adding = true; continue; }
      if (c === '-') { adding = false; continue; }
      const sigil = PREFIX_OF[c];
      if (sigil) {
        const nick = params[argIdx++];
        if (!nick) continue;
        nextMembers = nextMembers.map((m) => {
          if (m.nick !== nick) return m;
          if (adding) {
            // Promote only if the new sigil outranks the current one.
            if (prefixRank(sigil) <= prefixRank(m.prefix)) return m;
            return { ...m, prefix: sigil };
          }
          // Removal: drop only if currently exactly this sigil.
          return m.prefix === sigil ? { ...m, prefix: '' } : m;
        });
      } else if (LIST.has(c)) {
        const mask = params[argIdx++];
        if (c === 'b' && mask && bans) {
          if (adding) {
            if (!bans.some((b) => b.mask === mask)) { bans = [...bans, { mask }]; banChanged = true; }
          } else {
            const next = bans.filter((b) => b.mask !== mask);
            if (next.length !== bans.length) { bans = next; banChanged = true; }
          }
        }
      } else if (c === 'k') {
        const arg = params[argIdx++];
        if (adding) { if (modes.key !== arg) { modes.key = arg; modeChanged = true; } }
        else if (modes.key !== undefined) { modes.key = undefined; modeChanged = true; }
      } else if (c === 'l') {
        if (adding) {
          const n = Number(params[argIdx++]);
          if (Number.isFinite(n) && modes.limit !== n) { modes.limit = n; modeChanged = true; }
        } else if (modes.limit !== undefined) { modes.limit = undefined; modeChanged = true; }
      } else {
        // Boolean flag (i m n t s p r …).
        const has = modes.flags.includes(c);
        if (adding && !has) { modes.flags = [...modes.flags, c].sort(); modeChanged = true; }
        else if (!adding && has) { modes.flags = modes.flags.filter((x) => x !== c); modeChanged = true; }
      }
    }

    if (nextMembers !== ch.members) { ch.members = nextMembers; memberChanged = true; }
    if (modeChanged) ch.modes = modes;
    if (banChanged && bans) ch.bans = bans;
    if (memberChanged || modeChanged || banChanged) this.emit();
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

  // Coalesce listener notifications. emit() is called on EVERY engine event
  // (appendServerLog emits unconditionally, plus the per-kind branches), and
  // each notification runs getState() — which deep-clones every channel's
  // message array. A burst of events (a WHO/NAMES flood across several
  // connections, a bouncer buffer replay) would otherwise clone + re-render
  // once PER event, allocating faster than V8's GC can reclaim — Mark-Compact
  // thrashes and the heap climbs to OOM. Batching to a single notify per
  // microtask collapses any synchronous burst into one clone + render.
  //
  // We coalesce on a macrotask (setTimeout 0), NOT a microtask: each engine
  // event arrives as its own task (one WebSocket 'message' → one handleEvent),
  // and microtasks drain between tasks — so a microtask flush would still fire
  // once per event. A macrotask flush queues behind the already-pending event
  // tasks, so an entire burst drains into ONE clone + render.
  //
  // getState() stays synchronous and reads live state, so callers/tests that
  // read it directly after mutating are unaffected — only the subscriber
  // notification (the expensive clone + Preact re-render) is deferred.
  private emitScheduled = false;
  private emit(): void {
    // Every change passes here: a cheap check for a change of the
    // conversation on screen (memory windows).
    this.syncVisible();
    if (this.emitScheduled) return;
    this.emitScheduled = true;
    setTimeout(() => {
      this.emitScheduled = false;
      if (this.listeners.size === 0) return;
      const state = this.getState();
      this.listeners.forEach((fn) => {
        try { fn(state); } catch { /* isolate a bad subscriber */ }
      });
    }, 0);
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

// Timestamp for a message, preferring the IRCv3 server-time tag (`@time=`,
// RFC3339) so live messages are accurate and chathistory/backlog messages
// render at their original time. Falls back to now() when absent/unparseable.
export function eventTimestamp(e: IrcEvent): number {
  const t = e.Tags?.time;
  if (t) {
    const ms = Date.parse(t);
    if (!Number.isNaN(ms)) return ms;
  }
  return Date.now();
}

// Ergo with channels.operator-only-creation (a network where only admins
// create channels) refuses a JOIN of a channel that doesn't exist with
// 403 ERR_NOSUCHCHANNEL "Only server operators can create new channels".
export function isOperatorOnlyCreation(kind: string, message: string | undefined): boolean {
  return kind === '403' && /only server operators can create/i.test(message ?? '');
}

// What to say when the server refused a JOIN, when the raw reason isn't
// good enough; null = use it.
export function joinRefusalText(channel: string, kind: string, message: string | undefined, network: string): string | null {
  if (isOperatorOnlyCreation(kind, message)) {
    return `${channel} doesn't exist, and only admins can create channels on ${network || 'this network'}.`;
  }
  return null;
}

function normaliseChannel(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return '';
  return trimmed.startsWith('#') || trimmed.startsWith('&') ? trimmed : `#${trimmed}`;
}

// One RPL_WHOREPLY (352) line, as held until the member list is in.
interface WhoReply {
  flags: string;
  user?: string;
  host?: string;
  server?: string;
  realname?: string;
}

// `m` with a WHO reply applied, or null when it changes nothing. Flags: H
// (here) / G (gone), then `*` for an IRC operator, `B` for a bot, and the
// channel prefix sigils.
function withWhoReply(m: ChatMember, r: WhoReply): ChatMember | null {
  const awayMessage = r.flags.startsWith('G') ? (m.awayMessage ?? '') : null;
  const oper = r.flags.includes('*') || undefined;
  const bot = r.flags.slice(1).includes('B') || undefined;
  const user = r.user ?? m.user;
  const hostname = r.host ?? m.hostname;
  const server = r.server ?? m.server;
  const realname = r.realname ?? m.realname;
  if (
    awayMessage === m.awayMessage && oper === m.oper && bot === m.bot && user === m.user &&
    hostname === m.hostname && server === m.server && realname === m.realname
  ) return null;
  return { ...m, awayMessage, oper, bot, user, hostname, server, realname };
}

// A profile's WHOIS is reused for a minute; one with no end in sight is
// re-sent after this long.
const WHOIS_FRESH_MS = 60_000;
// How long a restored active channel may take to join before the first
// joined channel is shown instead.
const PREFERRED_ACTIVE_WAIT_MS = 4_000;
// How long after that the restored channel may still take over (see
// awaitPreferredActive).
const PREFERRED_ACTIVE_GIVE_UP_MS = 60_000;
const WHOIS_RETRY_MS = 10_000;

// Sigils in priority order — highest-rank first. When a server lists multiple
// (e.g. multi-prefix CAP gives `~@nick`), we keep the first and skip the rest.
const PREFIX_SIGILS = new Set(['~', '&', '@', '%', '+']);

// "2h ago in #lobby" for a remembered nick.
export function describeSeen(r: SeenRecord, now: number = Date.now()): string {
  const secs = Math.max(0, Math.floor((now - r.lastSeenAt) / 1000));
  const ago = secs < 60 ? 'just now'
    : secs < 3600 ? `${Math.floor(secs / 60)}m ago`
    : secs < 86400 ? `${Math.floor(secs / 3600)}h ago`
    : `${Math.floor(secs / 86400)}d ago`;
  return r.channels[0] ? `${ago} in ${r.channels[0]}` : ago;
}

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
    const user = atIdx > 0 ? userhost.slice(0, atIdx) : undefined;
    return hostname ? { nick, prefix, user, hostname } : { nick, prefix };
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
