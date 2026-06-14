package ipc

import (
	"encoding/json"

	"github.com/boson-chat/boson/engine/irc"
)

// Inbound: messages from the renderer (Electron) to the engine.

type ClientMessage struct {
	Type   string          `json:"type"`
	Params json.RawMessage `json:"params,omitempty"`
}

// Every params shape carries a ServerID minted by the renderer. The engine
// stores a map[serverId]*irc.Client per WebSocket session so a single
// renderer can drive multiple concurrent IRC connections.

type ConnectParams struct {
	ServerID string     `json:"serverId"`
	Hostname string     `json:"hostname"`
	Port     int        `json:"port"`
	TLS      bool       `json:"tls"`
	Nick     string     `json:"nick"`
	SASL     *SASLPlain `json:"sasl,omitempty"`
	// Optional NickServ password. Stored renderer-side per-server (plain
	// text in localStorage today) and shipped here on every connect /
	// reconnect. When non-empty the engine auto-sends NickServ IDENTIFY
	// after RPL_WELCOME. Omit / empty to disable.
	NickservPassword string `json:"nickservPassword,omitempty"`
	// ServerPass is the IRC PASS line for bouncer auth (ZNC:
	// "username[/network]:password"), sent before registration. Empty for
	// direct connections. Sensitive — never logged.
	ServerPass string `json:"serverPass,omitempty"`
	// TLSInsecure skips TLS cert verification (self-signed bouncer certs).
	// Only honoured when TLS is true.
	TLSInsecure bool `json:"tlsInsecure,omitempty"`
}

type SASLPlain struct {
	User     string `json:"user"`
	Password string `json:"password"`
}

type JoinParams struct {
	ServerID string `json:"serverId"`
	Channel  string `json:"channel"`
}

type PrivmsgParams struct {
	ServerID string `json:"serverId"`
	Target   string `json:"target"`
	Message  string `json:"message"`
}

// NamesParams targets a single channel for an on-demand NAMES refresh.
type NamesParams struct {
	ServerID string `json:"serverId"`
	Channel  string `json:"channel"`
}

// TagmsgParams sends an IRCv3 TAGMSG — used today for typing indicators.
// `tags` is sent verbatim; the engine has no opinion about which client tags
// are valid (e.g. `+typing=active`).
type TagmsgParams struct {
	ServerID string            `json:"serverId"`
	Target   string            `json:"target"`
	Tags     map[string]string `json:"tags"`
}

// ListParams requests the server's channel directory. The renderer's
// ChatService caches results; the renderer should not call this on every
// view — once at welcome + on user-driven refresh is plenty.
type ListParams struct {
	ServerID string `json:"serverId"`
}

// DisconnectParams shuts down a single server's IRC client. Without a
// serverId the engine returns an error rather than tearing down everything,
// to keep accidental disconnects scoped.
type DisconnectParams struct {
	ServerID string `json:"serverId"`
}

// AwayParams sets the user's IRC AWAY status on a given server. Empty
// Message clears away (i.e. /BACK). The server echoes RPL_NOWAWAY (306)
// or RPL_UNAWAY (305) once the request lands.
type AwayParams struct {
	ServerID string `json:"serverId"`
	Message  string `json:"message"`
}

// NickParams changes the user's IRC nickname on a given server. The
// server replies with a NICK event (server-wide, echoed to every
// channel the user is in) on success; on failure it returns an ERR_*
// numeric (e.g. 432 ERR_ERRONEUSNICKNAME, 433 ERR_NICKNAMEINUSE) which
// the renderer surfaces via the existing 4xx-error error-banner path.
type NickParams struct {
	ServerID string `json:"serverId"`
	Nick     string `json:"nick"`
}

// NickservIdentifyParams fires `PRIVMSG NickServ IDENTIFY <password>`
// on demand — the "Identify now" button in the Advanced settings
// panel. Auto-identify-on-connect goes through ConnectParams instead;
// this is for the manual re-trigger path.
type NickservIdentifyParams struct {
	ServerID string `json:"serverId"`
	Password string `json:"password"`
}

// RawParams forwards a verbatim IRC protocol line. Used by the
// renderer's slash-command dispatcher for verbs that don't have a
// dedicated method on the client (MOTD, VERSION, LUSERS, WHOIS, WHO,
// WHOWAS, ADMIN, TIME, LINKS, MODE …). The engine doesn't parse or
// validate the line — that's the daemon's job; we just forward.
type RawParams struct {
	ServerID string `json:"serverId"`
	Line     string `json:"line"`
}

const (
	CmdConnect           = "connect"
	CmdDisconnect        = "disconnect"
	CmdJoin              = "join"
	CmdPart              = "part"
	CmdPrivmsg           = "privmsg"
	CmdNames             = "names"
	CmdTagmsg            = "tagmsg"
	CmdList              = "list"
	CmdAway              = "away"
	CmdNick              = "nick"
	CmdNickservIdentify  = "nickserv-identify"
	CmdRaw               = "raw"
)

// Outbound: messages from the engine to the renderer.

type ServerMessage struct {
	Type     string                       `json:"type"`               // see Msg* below
	ServerID string                       `json:"serverId,omitempty"` // empty for transport-level errors
	Event    *irc.Event                   `json:"event,omitempty"`    // populated when Type == "event"
	State    string                       `json:"state,omitempty"`    // populated when Type == "status"
	Error    string                       `json:"error,omitempty"`    // populated when Type == "error"
	// Directory carries the full channel list emitted when a LIST cycle
	// completes (engine accumulates 322s, fires once on 323). Populated only
	// when Type == "channel-directory".
	Directory []irc.ChannelDirectoryEntry `json:"directory,omitempty"`
	// Framework is the detected services package for this serverId —
	// "atheme" | "anope" | "unknown". Populated only when Type ==
	// "services-framework". Fires once per detected-state transition.
	Framework string `json:"framework,omitempty"`
}

const (
	MsgEvent             = "event"
	MsgStatus            = "status"
	MsgError             = "error"
	MsgChannelDirectory  = "channel-directory"
	MsgServicesFramework = "services-framework"

	StateConnecting   = "connecting"
	StateConnected    = "connected"
	StateDisconnected = "disconnected"
)
