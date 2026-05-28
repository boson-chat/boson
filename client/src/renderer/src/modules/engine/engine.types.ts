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
}

export interface JoinParams { serverId: string; channel: string }
export interface PrivmsgParams { serverId: string; target: string; message: string }
export interface NamesParams { serverId: string; channel: string }
export interface DisconnectParams { serverId: string }
export interface TagmsgParams { serverId: string; target: string; tags: Record<string, string> }
export interface ListParams { serverId: string }
export interface AwayParams { serverId: string; message: string }
export interface NickParams { serverId: string; nick: string }

export interface ClientCommand {
  type: 'connect' | 'disconnect' | 'join' | 'part' | 'privmsg' | 'names' | 'tagmsg' | 'list' | 'away' | 'nick';
  params?: ConnectParams | JoinParams | PrivmsgParams | NamesParams | DisconnectParams | TagmsgParams | ListParams | AwayParams | NickParams;
}

export type PartParams = JoinParams;

export interface IrcEvent {
  Kind: string;
  From: string;
  Target: string;
  Message: string;
  Args?: string[]; // populated by KICK (kicked nick) + MODE (modestring + args)
  Tags?: Record<string, string>; // IRCv3 message tags (e.g. "+typing": "active")
  Raw: string;
}

export type EngineState = 'idle' | 'connecting' | 'connected' | 'disconnected';

// One row from the server's LIST reply, delivered as a finished block when
// the engine sees RPL_LISTEND (323). The renderer never sees the
// per-line 322 events — the engine accumulates and ships once.
export interface ChannelDirectoryEntry {
  name: string;
  userCount: number;
  topic: string;
}

export interface ServerMessage {
  type: 'event' | 'status' | 'error' | 'channel-directory';
  serverId?: string;       // empty for transport-level errors
  event?: IrcEvent;
  state?: EngineState;
  error?: string;
  directory?: ChannelDirectoryEntry[];
}
