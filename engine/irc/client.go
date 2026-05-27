// Package irc wraps girc with the surface the local Go process exposes to
// Electron. Lives client-side per the PRD; the boson backend never imports it.
package irc

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"time"

	"github.com/lrstanley/girc"
)

type Config struct {
	Hostname    string
	Port        int
	TLS         bool
	Nick        string
	User        string // ident
	RealName    string
	SASL        *SASLPlain
	ConnTimeout time.Duration
}

type SASLPlain struct {
	User     string
	Password string
}

// Event mirrors the subset of girc message types we forward to Electron.
type Event struct {
	Kind    string            // "PRIVMSG" | "NOTICE" | "JOIN" | "PART" | "QUIT" | "001" (welcome) | "TAGMSG" | etc.
	From    string            // nick/source
	Target  string            // channel or our nick (for DMs)
	Message string            // trailing message (reason, body, etc.)
	Args    []string          `json:"Args,omitempty"`  // additional positional params (KICK: kicked-nick; MODE: modestring + args)
	Tags    map[string]string `json:"Tags,omitempty"`  // IRCv3 message tags (e.g. "+typing": "active")
	Raw     string
}

type EventHandler func(Event)

// ChannelDirectoryEntry is a single line of the server's LIST reply.
type ChannelDirectoryEntry struct {
	Name      string `json:"name"`
	UserCount int    `json:"userCount"`
	Topic     string `json:"topic"`
}

// ChannelDirectoryHandler is invoked once per completed LIST cycle, with
// the full set of entries accumulated between RPL_LISTSTART/first 322 and
// RPL_LISTEND (323). The renderer treats it as an atomic update.
type ChannelDirectoryHandler func([]ChannelDirectoryEntry)

type Client struct {
	cfg                 Config
	girc                *girc.Client
	onEvent             EventHandler
	onChannelDirectory  ChannelDirectoryHandler
	// Accumulator for the in-flight LIST reply. Reset on RPL_LISTEND.
	pendingDirectory    []ChannelDirectoryEntry
	autoListScheduled   bool
}

func New(cfg Config) (*Client, error) {
	if cfg.Hostname == "" {
		return nil, errors.New("irc: hostname is required")
	}
	if cfg.Port <= 0 || cfg.Port > 65535 {
		return nil, errors.New("irc: port must be 1..65535")
	}
	if cfg.Nick == "" {
		return nil, errors.New("irc: nick is required")
	}
	if cfg.User == "" {
		cfg.User = cfg.Nick
	}
	if cfg.RealName == "" {
		cfg.RealName = cfg.Nick
	}
	if cfg.ConnTimeout == 0 {
		cfg.ConnTimeout = 15 * time.Second
	}

	gc := girc.New(girc.Config{
		Server:     cfg.Hostname,
		Port:       cfg.Port,
		Nick:       cfg.Nick,
		User:       cfg.User,
		Name:       cfg.RealName,
		SSL:        cfg.TLS,
		PingDelay:  30 * time.Second,
		PingTimeout: 30 * time.Second,
		SASL:       saslConfig(cfg.SASL),
		// IRCv3 capabilities we negotiate at connect:
		//   message-tags     — required to send/receive client tags like +typing
		//   server-time      — server-stamps messages with a UTC timestamp
		//   account-tag      — exposes authenticated account on each message
		//   away-notify      — server pushes AWAY events for channel members,
		//                       so the renderer's "away" indicator updates
		//                       in real time instead of only on the next
		//                       WHO/WHOIS the user triggers manually.
		// Servers that don't advertise these silently ignore the request.
		SupportedCaps: map[string][]string{
			"message-tags": nil,
			"server-time":  nil,
			"account-tag":  nil,
			"away-notify":  nil,
		},
	})

	return &Client{cfg: cfg, girc: gc}, nil
}

func saslConfig(s *SASLPlain) girc.SASLMech {
	if s == nil {
		return nil
	}
	return &girc.SASLPlain{User: s.User, Pass: s.Password}
}

// OnEvent sets the callback invoked for messages we expose. Must be called
// before Connect.
func (c *Client) OnEvent(fn EventHandler) {
	c.onEvent = fn
	c.girc.Handlers.AddBg(girc.ALL_EVENTS, func(_ *girc.Client, e girc.Event) {
		// Intercept directory-list lifecycle before forwarding the generic
		// event stream. The renderer doesn't need the per-line 322 frames —
		// just the final atomic update.
		switch e.Command {
		case girc.RPL_LIST:
			c.collectListEntry(e)
		case girc.RPL_LISTEND:
			c.flushListEntries()
		case girc.RPL_WELCOME:
			c.scheduleAutoList()
		case girc.JOIN:
			// Our own JOIN echo? Send a plain /WHO on the channel so
			// 352 RPL_WHOREPLY lines flow back with H/G flags — that's
			// how we learn the away state of members who were already
			// away when we joined (away-notify only pushes state
			// changes from that moment on). Nick compare must be
			// RFC1459 case-insensitive since servers may normalise
			// casing differently from how we registered.
			//
			// Note: girc's own JOIN handler also auto-sends a WHO, but
			// uses WHOX format `%tacuhnr,1` (no flags field) and the
			// server replies as 354 — useless for away detection. So
			// we issue a plain WHO ourselves and accept the duplicate
			// round-trip.
			if e.Source != nil &&
				girc.ToRFC1459(e.Source.Name) == girc.ToRFC1459(c.girc.GetNick()) &&
				len(e.Params) >= 1 {
				slog.Info("irc: sending plain WHO on self-join",
					"channel", e.Params[0], "nick", c.girc.GetNick())
				if err := c.girc.Cmd.SendRaw("WHO " + e.Params[0]); err != nil {
					slog.Error("irc: WHO send failed", "channel", e.Params[0], "err", err)
				}
			} else if e.Source != nil {
				slog.Debug("irc: JOIN echo not self",
					"source", e.Source.Name, "self", c.girc.GetNick())
			}
		}
		if c.onEvent == nil {
			return
		}
		evt := translate(e)
		if evt.Kind != "" {
			c.onEvent(evt)
		}
	})
}

// OnChannelDirectory registers a callback fired when a LIST cycle finishes.
// Must be called before Connect for the auto-fetch (post-RPL_WELCOME) to
// deliver. Auto-fetch fires once per connection, ~2.5s after welcome to
// avoid racing the MOTD burst.
func (c *Client) OnChannelDirectory(fn ChannelDirectoryHandler) {
	c.onChannelDirectory = fn
}

func (c *Client) collectListEntry(e girc.Event) {
	// 322 mynick <channel> <#users> :<topic>
	if len(e.Params) < 3 {
		return
	}
	name := e.Params[1]
	users := 0
	fmt.Sscanf(e.Params[2], "%d", &users)
	c.pendingDirectory = append(c.pendingDirectory, ChannelDirectoryEntry{
		Name:      name,
		UserCount: users,
		Topic:     e.Last(),
	})
}

func (c *Client) flushListEntries() {
	entries := c.pendingDirectory
	c.pendingDirectory = nil
	if c.onChannelDirectory != nil {
		c.onChannelDirectory(entries)
	}
}

func (c *Client) scheduleAutoList() {
	if c.autoListScheduled {
		return
	}
	c.autoListScheduled = true
	go func() {
		time.Sleep(2500 * time.Millisecond)
		c.girc.Cmd.SendRaw("LIST")
	}()
}

// Connect blocks until the context is cancelled or the underlying
// connection ends. Returns nil on context cancellation (graceful shutdown)
// and non-nil on transport errors.
func (c *Client) Connect(ctx context.Context) error {
	errCh := make(chan error, 1)
	go func() { errCh <- c.girc.Connect() }()

	select {
	case <-ctx.Done():
		c.girc.Quit("shutting down")
		// Drain so the goroutine exits before we return.
		<-errCh
		return nil
	case err := <-errCh:
		return err
	}
}

// Join joins a channel. Safe to call before connect; girc queues it.
func (c *Client) Join(channel string) {
	c.girc.Cmd.Join(channel)
}

// Part leaves a channel.
func (c *Client) Part(channel string) {
	c.girc.Cmd.Part(channel)
}

// Privmsg sends a message to a channel or user.
func (c *Client) Privmsg(target, message string) {
	c.girc.Cmd.Message(target, message)
}

// Quit ends the IRC session with the given reason.
func (c *Client) Quit(reason string) {
	c.girc.Quit(reason)
}

// Names requests a NAMES refresh for a channel. Server replies with one or
// more RPL_NAMREPLY (353) followed by RPL_ENDOFNAMES (366) — the renderer's
// ChatService re-syncs the member list from those.
func (c *Client) Names(channel string) {
	c.girc.Cmd.SendRaw("NAMES " + channel)
}

// List asks the server for its full channel directory. The reply is one
// RPL_LIST (322) per channel, terminated by RPL_LISTEND (323). Each 322
// carries the channel name, member count, and topic.
//
// Heavy on big networks (Libera has ~50k channels), so callers should
// throttle requests — the renderer's ChatService caches results and only
// re-issues on user demand. Some servers also rate-limit LIST or require
// a pattern; we issue a bare LIST which is the universal form.
func (c *Client) List() {
	c.girc.Cmd.SendRaw("LIST")
}

// Away sets the user's IRC away status. Empty message clears it (the
// IRC `/BACK` semantics). Server replies with RPL_NOWAWAY (306) or
// RPL_UNAWAY (305) which we translate in the event loop.
func (c *Client) Away(message string) {
	if message == "" {
		c.girc.Cmd.SendRaw("AWAY")
	} else {
		c.girc.Cmd.SendRaw("AWAY :" + message)
	}
}

// Tagmsg sends an IRCv3 TAGMSG to `target`, carrying only message tags (no
// body). Used today for typing indicators (`+typing=active|done|paused`);
// future client tags (read receipts, reactions) ride the same wire. Servers
// that don't support `message-tags` drop the tags; servers that don't know
// TAGMSG silently ignore the frame.
func (c *Client) Tagmsg(target string, tags map[string]string) {
	if len(tags) == 0 {
		return
	}
	t := girc.Tags(tags)
	c.girc.Send(&girc.Event{
		Command: "TAGMSG",
		Params:  []string{target},
		Tags:    t,
	})
}

func (c *Client) String() string {
	return fmt.Sprintf("%s@%s:%d (tls=%t)", c.cfg.Nick, c.cfg.Hostname, c.cfg.Port, c.cfg.TLS)
}

// translate converts a girc.Event into our wire-level Event.
func translate(e girc.Event) Event {
	out := Event{Kind: e.Command, Raw: e.String()}
	if e.Source != nil {
		out.From = e.Source.Name
	}
	// Forward any IRCv3 tags girc parsed off the wire. We keep client tags
	// (prefix `+`) and server-time / account so the renderer can act on
	// them; raw map[string]string is the right shape for JSON.
	if len(e.Tags) > 0 {
		out.Tags = make(map[string]string, len(e.Tags))
		for k, v := range e.Tags {
			out.Tags[k] = v
		}
	}
	switch e.Command {
	case girc.PRIVMSG, girc.NOTICE:
		if len(e.Params) >= 1 {
			out.Target = e.Params[0]
		}
		out.Message = e.Last()
	case girc.JOIN, girc.PART:
		if len(e.Params) >= 1 {
			out.Target = e.Params[0]
		}
	case girc.QUIT:
		out.Message = e.Last()
	case girc.NICK:
		// :oldnick NICK newnick — From is the old nick (Source), Message is the new nick.
		if len(e.Params) >= 1 {
			out.Message = e.Params[0]
		}
	case girc.KICK:
		// :kicker KICK #chan kicked :reason
		if len(e.Params) >= 2 {
			out.Target = e.Params[0]
			out.Args = []string{e.Params[1]}
		}
		out.Message = e.Last()
	case girc.MODE:
		// :setter MODE #chan +oo-v alice bob carol  (or +i with no args)
		// Channel is param 0; the rest are the mode string + its arguments.
		if len(e.Params) >= 2 {
			out.Target = e.Params[0]
			out.Args = append([]string(nil), e.Params[1:]...)
		}
	case girc.RPL_WHOREPLY:
		// 352 mynick #channel ident host server nick H|G[@%+...] :hopcount realname
		// Used here to retroactively detect users who were already away
		// when we joined the channel (the away-notify CAP only pushes
		// state CHANGES, not the current state at join). Status field is
		// 'H' here / 'G' gone (away), followed by optional sigils.
		if len(e.Params) >= 7 {
			out.Target = e.Params[1]         // channel
			out.From = e.Params[5]           // nick
			out.Args = []string{e.Params[6]} // status flags
			slog.Info("irc: forwarding RPL_WHOREPLY",
				"channel", out.Target, "nick", out.From, "flags", e.Params[6])
		} else {
			slog.Warn("irc: 352 too short", "params", e.Params)
		}
		out.Message = e.Last()
	case girc.RPL_WHOSPCRPL:
		// 354 — WHOX reply. girc's auto-WHO uses WHOX format; the field
		// order depends on the querytype. We don't request any flags
		// field in our own WHO (we send plain 352-returning WHO), but
		// some servers may answer WHOX even to plain queries. The
		// renderer ignores 354 unless we ever start using it ourselves.
		slog.Debug("irc: RPL_WHOSPCRPL", "params", e.Params)
	case girc.RPL_ENDOFWHO:
		// 315 mynick <name> :End of /WHO list
		// Renderer doesn't need to act on this beyond noting completion;
		// included so the server log has the marker. Args[0] = channel.
		if len(e.Params) >= 2 {
			out.Target = e.Params[1]
		}
		out.Message = e.Last()
	case girc.AWAY:
		// :nick AWAY [:message]
		// IRCv3 away-notify push. Trailing param present ⇒ user is now
		// away with that message; trailing param missing ⇒ user came back.
		// From carries the nick (set above from Source).
		if len(e.Params) >= 1 || e.Last() != "" {
			out.Message = e.Last()
		}
	case girc.RPL_AWAY:
		// 301 mynick targetnick :away-message
		// Server-side reply when someone messages a user who is away.
		// Carries the target's nick in Args[0] and the message in trailing.
		if len(e.Params) >= 2 {
			out.Args = []string{e.Params[1]}
		}
		out.Message = e.Last()
	case girc.RPL_NOWAWAY:
		// 306 mynick :You have been marked as being away
		// Self-confirmation: our own /AWAY request landed.
		out.Message = e.Last()
	case girc.RPL_UNAWAY:
		// 305 mynick :You are no longer marked as being away
		// Self-confirmation: our own /AWAY (empty arg) landed.
		out.Message = e.Last()
	case girc.TOPIC:
		// :setter TOPIC #chan :new topic
		// Live topic change — broadcast to all channel members. Target
		// is the channel, Message is the new topic, From is the nick
		// that issued the change.
		if len(e.Params) >= 1 {
			out.Target = e.Params[0]
		}
		out.Message = e.Last()
	case girc.RPL_TOPIC:
		// 332 mynick #chan :existing topic
		// Sent on JOIN to deliver the current topic.
		if len(e.Params) >= 2 {
			out.Target = e.Params[1]
		}
		out.Message = e.Last()
	case girc.RPL_NOTOPIC:
		// 331 mynick #chan :No topic is set
		// Counterpart to 332 when the channel has no topic. Renderer
		// treats this as an empty-string topic.
		if len(e.Params) >= 2 {
			out.Target = e.Params[1]
		}
		out.Message = ""
	case girc.RPL_TOPICWHOTIME:
		// 333 mynick #chan setter-nick set-at-unix
		// Optional metadata — who last set the topic and when.
		if len(e.Params) >= 4 {
			out.Target = e.Params[1]
			out.Args = []string{e.Params[2], e.Params[3]}
		}
	case girc.RPL_NAMREPLY:
		// 353 mynick = #channel :@op +voice nick3 nick4
		// Channel is the third param; the trailing parameter is the
		// space-separated names (with prefix sigils for op/voice/etc.).
		if len(e.Params) >= 3 {
			out.Target = e.Params[2]
		}
		out.Message = e.Last()
	case girc.RPL_ENDOFNAMES:
		// 366 mynick #channel :End of /NAMES list.
		if len(e.Params) >= 2 {
			out.Target = e.Params[1]
		}
	case girc.RPL_WELCOME, girc.RPL_MOTD, girc.RPL_ENDOFMOTD:
		out.Message = e.Last()
	case girc.RPL_MYINFO:
		// 004 mynick <servername> <version> <usermodes> <chanmodes>
		// Send the server's hostname + version as Args so the renderer can
		// show "Solanum 1.0-dev" next to the connection status.
		if len(e.Params) >= 3 {
			out.Args = []string{e.Params[1], e.Params[2]}
		}
	case girc.RPL_ISUPPORT:
		// 005 mynick <TOKEN=value>... :are supported by this server
		// Forward the tokens verbatim; the renderer cherry-picks NETWORK= for
		// the badge and ignores the rest.
		if len(e.Params) > 2 {
			out.Args = append([]string(nil), e.Params[1:len(e.Params)-1]...)
		}
		out.Message = e.Last()
	case "TAGMSG":
		// TAGMSG carries no body — only tags. Target (channel or nick) is
		// param 0. Used for typing indicators today.
		if len(e.Params) >= 1 {
			out.Target = e.Params[0]
		}
	case girc.CAP:
		// CAP <target> <subcommand> [...args...] [:trailing-list]
		// Forward subcommand + the trailing capability list so the renderer
		// can surface which IRCv3 caps the server actually ACKed for this
		// session. Useful to confirm `message-tags` (required for +typing)
		// is live on an unfamiliar server.
		if len(e.Params) >= 2 {
			out.Args = append([]string(nil), e.Params[1:]...)
		}
		out.Message = e.Last()
	default:
		// Forward IRC error numerics (4xx, 5xx) so the renderer can surface
		// rejection reasons — e.g. 432 ERR_ERRONEUSNICKNAME, 433
		// ERR_NICKNAMEINUSE, 464 ERR_PASSWDMISMATCH. Without this the client
		// silently stalls after the pre-registration NOTICEs.
		if len(e.Command) == 3 && (e.Command[0] == '4' || e.Command[0] == '5') {
			out.Message = e.Last()
			return out
		}
		return Event{}
	}
	return out
}
