export type ChatMessageKind = 'message' | 'notice' | 'join' | 'part' | 'quit' | 'kick' | 'system' | 'action';

export interface ChatMessage {
  id: string;       // local UUID
  kind: ChatMessageKind;
  from: string;     // empty for 'system'
  text: string;
  timestamp: number; // epoch ms
}

// IRC channel-status prefix sigils. Common: `@` op, `+` voice, `%` halfop,
// `~` founder/owner, `&` admin. We keep only the most senior sigil when a
// server reports multiple.
export type MemberPrefix = '@' | '+' | '%' | '~' | '&' | '';

// ChatMember is the rendered record for a user in a specific channel. Fields
// other than `nick` + `prefix` are populated opportunistically from IRC events
// as we observe them; consumers should treat them all as optional.
//
// Source of each field:
//   nick          — RPL_NAMREPLY (353), JOIN, NICK
//   prefix        — RPL_NAMREPLY (353); future: MODE +o/-o updates
//   joinedAt      — local clock at the moment we saw their JOIN
//   lastActiveAt  — local clock at their last PRIVMSG/NOTICE/ACTION
//   realname      — TODO: RPL_WHOISUSER (311) — not yet forwarded by engine
//   hostname      — TODO: RPL_WHOISUSER (311) — not yet forwarded by engine
//   account       — TODO: RPL_WHOISACCOUNT (330) or extended-join CAP
//   awayMessage   — TODO: RPL_AWAY (301); null = explicitly back, undefined = unknown
export interface ChatMember {
  nick: string;
  prefix: MemberPrefix;
  joinedAt?: number;
  lastActiveAt?: number;
  realname?: string;
  hostname?: string;
  account?: string;
  awayMessage?: string | null;
}

export interface ChatChannel {
  name: string;
  messages: ChatMessage[];
  joined: boolean;
  members: ChatMember[];
  // Nicks currently typing in this channel, per IRCv3 +typing client tag.
  // Populated by TAGMSG `+typing=active`; cleared by `+typing=done`/`paused`,
  // a PRIVMSG from the same nick, or an expiry timer (~6s, per spec).
  typing: string[];
  // Unread / mention counters. Incremented on each PRIVMSG / NOTICE / ACTION
  // we receive in this channel while it is NOT the currently-active one.
  // Cleared when the user switches to the channel via setActive(). Self-
  // messages don't count. `mentions` is a subset of `unread`: only the
  // messages where another user said our own nick.
  unread: number;
  mentions: number;
  // Channel topic. Populated by RPL_TOPIC (332) on JOIN, updated by the
  // TOPIC echo when anyone changes it, set to empty string by RPL_NOTOPIC
  // (331). `topicSetBy` + `topicSetAt` come from RPL_TOPICWHOTIME (333)
  // when the server bothers to send it (not all do).
  topic: string;
  topicSetBy?: string;
  topicSetAt?: number;
}

// One captured raw IRC event for the dev-tools-style server log. Every event
// the engine forwards is appended here BEFORE the chat-layer's per-kind
// branching, so the UI can show the full handshake (NOTICE / 001 RPL_WELCOME /
// MOTD chunks / ISUPPORT / etc.) as it happens. Capped at SERVER_LOG_CAP
// entries — oldest evicted first.
export interface ServerLogEntry {
  id: string;
  kind: string;
  from: string;
  target: string;
  message: string;
  timestamp: number;
  // Extra positional params from the IRC line. For numeric replies the
  // structured data is often here rather than in Message (e.g. RPL_VERSION
  // 351 carries `version.string` in Args[0], comment in Message; RPL_LUSEROP
  // 252 carries the count in Args[0], description in Message). Empty for
  // most non-numeric event kinds.
  args?: string[];
}

// Server-software metadata captured during registration. Populated lazily as
// the relevant IRC numerics arrive (004 / 005). Fields stay `undefined` until
// we see them — they're informational only, never load-bearing.
//
// Source of each field:
//   serverName   — RPL_MYINFO (004) param 1 (the daemon's hostname)
//   version      — RPL_MYINFO (004) param 2 (e.g., "solanum-1.0-dev")
//   network      — RPL_ISUPPORT (005) `NETWORK=` token (e.g., "Libera.Chat")
export interface ServerInfo {
  serverName?: string;
  version?: string;
  network?: string;
  // IRCv3 capabilities the server ACKed during CAP negotiation for *this*
  // session. Empty until we see at least one `CAP * ACK` frame. The UI uses
  // it to confirm which features are actually live (e.g. `message-tags` is
  // required for +typing — without it the indicator silently no-ops).
  enabledCaps?: string[];
}

// One channel as advertised by the server's LIST reply (RPL_LIST / 322).
// Populated when the user (or chat.service on welcome) issues a LIST and
// terminated by RPL_LISTEND (323). Used to power the join-channel
// autocomplete in the channel sidebar's join modal.
export interface ChannelDirectoryEntry {
  name: string;       // e.g. "#general" — preserves server casing
  userCount: number;  // current member count
  topic: string;      // raw topic; may include IRC color codes (renderer strips)
}

// State of the channel-directory cache.
//   - 'idle'    : no LIST has been issued yet for this connection
//   - 'loading' : LIST issued, waiting for RPL_LISTEND
//   - 'ready'   : at least one full LIST cycle has completed
export type ChannelDirectoryStatus = 'idle' | 'loading' | 'ready';

export interface ChannelDirectory {
  status: ChannelDirectoryStatus;
  entries: ReadonlyArray<ChannelDirectoryEntry>;
  // When the directory was last refreshed (epoch ms). Null if never.
  updatedAt: number | null;
}

export interface ChatState {
  channels: ChatChannel[];
  activeChannel: string | null;
  // Rolling window of recent raw engine events for the dev-tools log panel.
  // Newest entries are at the end. Bounded by SERVER_LOG_CAP in chat.service.
  serverLog: ReadonlyArray<ServerLogEntry>;
  // IRC server software / network identity, populated as 004/005 arrive.
  serverInfo: ServerInfo;
  // Server-advertised channel directory, populated from RPL_LIST. Used as
  // the source for the join-channel autocomplete.
  channelDirectory: ChannelDirectory;
  // Live IRC nickname on this server. Starts as whatever we passed at
  // connect; updates on every server-driven NICK event (our own renames
  // through /nick, NickServ-driven renames, server-forced renames).
  // The settings UI binds its "Change nick" form to this so it reflects
  // the authoritative value after a rename round-trips.
  myNick: string;
  // Detected services package (Atheme vs Anope vs unknown). Populated
  // passively by inspecting NOTICEs from NickServ et al. — null until
  // we've seen any service traffic, then 'atheme' / 'anope' once a
  // signature lands, or 'unknown' if a service interacted but the
  // banner didn't match any known pattern. Drives the Advanced
  // settings UI to show the right command surface.
  servicesFramework: 'atheme' | 'anope' | 'ergo' | 'unknown' | null;
}
