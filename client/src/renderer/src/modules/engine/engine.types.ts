// Mirrors engine/ipc/protocol.go on the Go side.
//
// Every command shape carries a renderer-minted `serverId` so a single
// WebSocket session can drive multiple concurrent IRC clients. Outbound
// ServerMessages echo that id back so the renderer can route events to the
// correct ServerSession.

export interface ConnectParams {
  serverId: string;
  hostname: string;
  port: number;
  tls: boolean;
  nick: string;
  sasl?: { user: string; password: string };
  // Optional NickServ password — when present, the engine auto-sends
  // `PRIVMSG NickServ IDENTIFY <password>` immediately after
  // RPL_WELCOME. Plain-text in localStorage today, shipped on every
  // connect / reconnect.
  nickservPassword?: string;
  // Bouncer (ZNC/BNC) auth: the IRC PASS line, "username[/network]:password",
  // sent before registration (girc.Config.ServerPass). Omitted for direct
  // connections. Sensitive — never log it.
  serverPass?: string;
  // Skip TLS certificate verification (self-signed bouncer certs only).
  // Footgun; only honoured when tls is true.
  tlsInsecure?: boolean;
  // The renderer routed this connection through the user's bouncer profile.
  // Lets the engine treat it as a bouncer link from the start (before any
  // ZNC fingerprint is seen) and emit `bouncer-upstream` frames.
  bouncer?: boolean;
  // When the bouncer reports its upstream network disconnected at attach
  // time, the engine asks it to connect (`PRIVMSG *status :connect`)
  // automatically. At most once per engine connection; never after an
  // explicit `bouncer-disconnect`.
  bouncerAutoConnect?: boolean;
}

export interface JoinParams { serverId: string; channel: string }
export interface PrivmsgParams { serverId: string; target: string; message: string }
export interface NamesParams { serverId: string; channel: string }
export interface DisconnectParams { serverId: string }
export interface TagmsgParams { serverId: string; target: string; tags: Record<string, string> }
export interface ListParams { serverId: string }
export interface AwayParams { serverId: string; message: string }
export interface NickParams { serverId: string; nick: string }
export interface NickservIdentifyParams { serverId: string; password: string }
// Raw IRC line forwarded verbatim to the daemon. Used for slash
// commands that don't have a dedicated typed primitive on the engine
// (MOTD, LUSERS, VERSION, ADMIN, WHOIS, WHOWAS, WHO, LIST with arg,
// LINKS, MODE …). The engine doesn't parse — the daemon's reply
// arrives through the normal event stream.
export interface RawParams { serverId: string; line: string }
// Ask the bouncer to connect / disconnect its upstream IRC network.
export interface BouncerUpstreamParams { serverId: string }

export interface ClientCommand {
  type: 'connect' | 'disconnect' | 'join' | 'part' | 'privmsg' | 'names' | 'tagmsg' | 'list' | 'away' | 'nick' | 'nickserv-identify' | 'raw' | 'bouncer-connect' | 'bouncer-disconnect';
  params?: ConnectParams | JoinParams | PrivmsgParams | NamesParams | DisconnectParams | TagmsgParams | ListParams | AwayParams | NickParams | NickservIdentifyParams | RawParams | BouncerUpstreamParams;
}

export type PartParams = JoinParams;

export interface IrcEvent {
  Kind: string;
  From: string;
  Target: string;
  Message: string;
  Args?: string[]; // populated by KICK (kicked nick) + MODE (modestring + args)
  Tags?: Record<string, string>; // IRCv3 message tags (e.g. "+typing": "active")
  // Source hostname from the nick!user@host prefix, when present (NAMES with
  // userhost-in-names, JOIN, messages, WHO 352, CHGHOST). Drives presence.
  Host?: string;
  // Source's services account when known (account-tag / extended-join /
  // ACCOUNT); empty/absent = not identified.
  Account?: string;
  // Set when this event tells us *we* became an IRC operator — numeric 381
  // (RPL_YOUREOPER) or a self user-mode grant (MODE <ournick> +o). Never set
  // for channel +o (ops) or other users' modes.
  IsOper?: boolean;
  Raw: string;
}

export type EngineState = 'idle' | 'connecting' | 'connected' | 'disconnected';

// Whether a bouncer (ZNC) is itself connected to the real IRC network
// ("upstream"). The engine's EngineState only describes the client <->
// bouncer link; this is the bouncer <-> network link. Only reported for
// bouncer connections.
export type BouncerUpstreamState = 'connected' | 'disconnected' | 'connecting';

// One row from the server's LIST reply, delivered as a finished block when
// the engine sees RPL_LISTEND (323). The renderer never sees the
// per-line 322 events — the engine accumulates and ships once.
export interface ChannelDirectoryEntry {
  name: string;
  userCount: number;
  topic: string;
}

// Engine-detected services package for a server connection. Empty
// string means "not detected" (the engine hasn't received any service
// reply yet). "unknown" means a service responded but didn't name
// itself in any reply within the probe window.
//
// Supported packages today:
//   atheme — atheme.org services (Solanum/Charybdis-family networks)
//   anope  — anope.org services (UnrealIRCd / InspIRCd-family)
//   ergo   — Ergo IRCd's built-in services (modern, self-contained)
//   unknown — service traffic seen, no signature matched (Bahamut,
//             UnderNet X/W, custom in-house, etc.)
export type ServicesFramework = 'atheme' | 'anope' | 'ergo' | 'unknown' | '';

export interface ServerMessage {
  type: 'event' | 'status' | 'error' | 'channel-directory' | 'services-framework' | 'bouncer-upstream';
  serverId?: string;       // empty for transport-level errors
  event?: IrcEvent;
  state?: EngineState;
  error?: string;
  directory?: ChannelDirectoryEntry[];
  // Populated only when type === 'services-framework'. Empty string is
  // never sent on the wire (engine omits the field); narrowed here to
  // the real values consumers care about.
  framework?: 'atheme' | 'anope' | 'ergo' | 'unknown';
  // Populated only when type === 'bouncer-upstream'.
  upstream?: BouncerUpstreamState;
}
