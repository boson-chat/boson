// Package irc wraps girc with the surface the local Go process exposes to
// Electron. Lives client-side per the PRD; the boson backend never imports it.
package irc

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"strings"
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
	// NickservPassword, when non-empty, triggers `PRIVMSG NickServ
	// IDENTIFY <password>` immediately after RPL_WELCOME. The engine
	// also runs the services-framework probe on welcome regardless.
	// Stored plain-text on the renderer side and passed down on each
	// connect / reconnect.
	NickservPassword string
}

type SASLPlain struct {
	User     string
	Password string
}

// Event mirrors the subset of girc message types we forward to Electron.
type Event struct {
	Kind    string            // "PRIVMSG" | "NOTICE" | "JOIN" | "PART" | "QUIT" | "001" (welcome) | "TAGMSG" | "ACCOUNT" | "CHGHOST" | etc.
	From    string            // nick/source
	Target  string            // channel or our nick (for DMs)
	Message string            // trailing message (reason, body, etc.)
	Args    []string          `json:"Args,omitempty"`  // additional positional params (KICK: kicked-nick; MODE: modestring + args)
	Tags    map[string]string `json:"Tags,omitempty"`  // IRCv3 message tags (e.g. "+typing": "active")
	// Host is the source's hostname (from the nick!user@host prefix), when
	// the wire carried one. Powers Boson-member presence matching.
	Host string `json:"Host,omitempty"`
	// Account is the source's services account name when known (from the
	// account-tag, extended-join, or an ACCOUNT event); empty = not logged in.
	Account string `json:"Account,omitempty"`
	// IsOper is set when this event tells us *we* became an IRC operator —
	// numeric 381 (RPL_YOUREOPER) or a self user-mode grant (MODE <ournick>
	// +o). It is never set for channel +o (ops) or for other users.
	IsOper bool `json:"IsOper,omitempty"`
	Raw    string
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
	listRetryScheduled  bool
	// Services detection + auto-identify state. Lives on the engine
	// (not the renderer) so every client of the engine — Electron,
	// future mobile / web — gets identical NickServ behaviour.
	services            *servicesState
}

// ServicesHandler fires when the detected services package (Atheme /
// Anope / unknown) changes for this client. The IPC layer wires this
// up to forward verdicts to the renderer; tests plug in recorders.
type ServicesHandler func(ServicesFramework)

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
		//   userhost-in-names — NAMES (353) lists nicks as nick!user@host, so
		//                       the renderer learns each member's hostname.
		//   extended-join    — JOIN carries the joiner's account + (via the
		//                       source) host; also gives us our OWN host +
		//                       account on self-join.
		//   account-notify   — server pushes ACCOUNT events when a user logs
		//                       in / out, so the account field stays live.
		//   chghost          — server pushes CHGHOST when a user's host
		//                       changes (cloak grant, vhost), keeping the
		//                       host current.
		// These identity signals back the "is this a Boson member?" presence
		// matching. Servers that don't advertise a cap silently ignore it.
		SupportedCaps: map[string][]string{
			"message-tags":      nil,
			"server-time":       nil,
			"account-tag":       nil,
			"away-notify":       nil,
			"userhost-in-names": nil,
			"extended-join":     nil,
			"account-notify":    nil,
			"chghost":           nil,
		},
	})

	c := &Client{cfg: cfg, girc: gc, services: newServicesState()}
	c.services.setNickservPassword(cfg.NickservPassword)
	return c, nil
}

// OnServices installs the services-framework verdict callback. Fires
// once per detected-state transition (empty → atheme/anope/unknown).
// Must be called before Connect.
func (c *Client) OnServices(fn ServicesHandler) {
	c.services.setOnChange(func(fw ServicesFramework) { fn(fw) })
}

// Services returns the current framework verdict — empty string before
// the post-welcome probe has classified.
func (c *Client) Services() ServicesFramework {
	return c.services.snapshot()
}

// NickservIdentify sends `PRIVMSG NickServ IDENTIFY <password>`. Used
// by the renderer's "Identify now" button when the user wants to
// re-run auto-identify without reconnecting.
func (c *Client) NickservIdentify(password string) {
	if password == "" {
		return
	}
	c.girc.Cmd.Message("NickServ", "IDENTIFY "+password)
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
			// Fire NickServ IDENTIFY (if configured) + VERSION probes to
			// classify the services package. Both are one-shot per
			// session — handled by latches inside servicesState.
			c.services.onWelcome(
				func(target, body string) { c.girc.Cmd.Message(target, body) },
				func(d time.Duration, fn func()) { time.AfterFunc(d, fn) },
			)
		case girc.PRIVMSG, girc.NOTICE:
			// Feed service-sourced messages into the framework classifier.
			// A hit on "atheme" / "anope" anywhere in the body settles
			// the verdict. The verdict callback flows up to the IPC
			// layer which forwards a services-framework message to the
			// renderer.
			if e.Source != nil && len(e.Params) >= 2 {
				c.services.observe(e.Source.Name, e.Last())
			}
		case girc.ERR_UNKNOWNCOMMAND:
			// 421 — Ergo (and similarly-configured Solanum) rejects
			// LIST issued inside the first ~60s of a connection with:
			//   :server 421 nick LIST :You must be connected for at
			//                              least 60 seconds before
			//                              you can use this command
			// We catch that one specific shape and schedule a retry
			// after the cool-off window. Other 421s (genuinely
			// unsupported commands, typo'd /raw input) get logged but
			// no special handling — they're surfaced to the renderer
			// via the normal event stream and the 4xx error-banner
			// path picks them up.
			if c.is421ForListThrottle(e) {
				slog.Info("irc: LIST throttled by server; scheduling retry",
					"detail", e.Last())
				c.scheduleListRetry()
			}
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

// initialAutoListDelay is short on the gamble most daemons accept
// LIST immediately. Ergo (and similarly-configured Solanum) rejects
// LIST issued inside the first ~60s with a 421 ERR_UNKNOWNCOMMAND
// carrying the message "You must be connected for at least 60 seconds
// before you can use this command" — we catch that specific reply and
// schedule a one-time retry after the cool-off window, see
// handleListThrottleRejection().
const initialAutoListDelay = 2500 * time.Millisecond

// listRetryDelay is the post-throttle retry. Slightly longer than
// the 60s the message advertises so we don't immediately race a
// fresh rate-limit window.
const listRetryDelay = 65 * time.Second

func (c *Client) scheduleAutoList() {
	if c.autoListScheduled {
		return
	}
	c.autoListScheduled = true
	go func() {
		time.Sleep(initialAutoListDelay)
		_ = c.girc.Cmd.SendRaw("LIST")
	}()
}

// is421ForListThrottle picks the specific 421 reply that means
// "LIST rejected due to connection-age rate limit" out of the
// generic ERR_UNKNOWNCOMMAND bucket. We match BOTH params (the
// rejected command name) AND message text so a real "LIST is not
// supported" reply on some obscure daemon doesn't trigger an
// infinite retry loop. Daemons that throttle without naming "60
// seconds" specifically fall through to no-retry; the manual
// Refresh button in the renderer still works.
func (c *Client) is421ForListThrottle(e girc.Event) bool {
	// 421 layout: :server 421 mynick <rejected-cmd> :<reason>
	if len(e.Params) < 2 {
		return false
	}
	if !strings.EqualFold(e.Params[1], "LIST") {
		return false
	}
	msg := strings.ToLower(e.Last())
	return strings.Contains(msg, "seconds") && strings.Contains(msg, "connected")
}

// scheduleListRetry fires a second LIST after `listRetryDelay`. Called
// from the event handler when we observe a 421 reply that names LIST
// as the throttled command. Guarded by `listRetryScheduled` so a
// flapping server can't snowball into a queue of pending retries.
func (c *Client) scheduleListRetry() {
	if c.listRetryScheduled {
		return
	}
	c.listRetryScheduled = true
	go func() {
		time.Sleep(listRetryDelay)
		_ = c.girc.Cmd.SendRaw("LIST")
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

// Nick changes the client's IRC nickname. The server replies with a
// NICK event (broadcast to every channel the user is in) on success or
// a 4xx numeric (433 ERR_NICKNAMEINUSE, 432 ERR_ERRONEUSNICKNAME,
// 437 ERR_UNAVAILRESOURCE) on failure. The translate() layer surfaces
// both shapes to the renderer through the normal event stream — no
// special-case ACK is needed here. We don't validate the nick locally;
// IRC daemons have nick-rules that vary (length, allowed chars,
// reserved prefixes) and the server's error is more authoritative than
// anything we could enforce client-side.
func (c *Client) Nick(nick string) {
	if nick == "" {
		return
	}
	_ = c.girc.Cmd.SendRaw("NICK " + nick)
}

// SendRaw forwards a raw IRC protocol line to the server unchanged
// (no CR/LF appended — girc handles that). Used for read-only
// commands the renderer surfaces in the Advanced settings panel
// (MOTD, VERSION, LUSERS, WHOIS, WHO, WHOWAS, ADMIN, TIME, LINKS,
// MODE …) where a dedicated typed method would be overkill. Replies
// flow through the normal event stream — the caller correlates by
// numeric kind.
//
// Empty lines are dropped; the daemon would treat them as parser
// errors and we'd rather no-op than push a malformed frame.
func (c *Client) SendRaw(line string) {
	line = strings.TrimSpace(line)
	if line == "" {
		return
	}
	_ = c.girc.Cmd.SendRaw(line)
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

// normalizeAccount maps the IRC "no account" sentinels ("*", "0", empty) to
// an empty string so callers can treat "" uniformly as "not identified".
func normalizeAccount(s string) string {
	if s == "" || s == "*" || s == "0" {
		return ""
	}
	return s
}

// isChannelName reports whether a MODE target is a channel rather than a
// nick. Channels start with one of the standard prefixes; anything else is
// a user (and a user-mode change is only ever about ourselves).
func isChannelName(s string) bool {
	if s == "" {
		return false
	}
	switch s[0] {
	case '#', '&', '+', '!':
		return true
	}
	return false
}

// grantsOper reports whether a mode string adds the +o flag. It walks the
// string tracking the current +/- sign so "-o+i" (removing o) is not a
// grant but "+i-v+o" is. Only the IRC-operator flag 'o' on a user matters
// here; callers gate on the target being a nick.
func grantsOper(modes string) bool {
	adding := true
	for _, c := range modes {
		switch c {
		case '+':
			adding = true
		case '-':
			adding = false
		case 'o':
			if adding {
				return true
			}
		}
	}
	return false
}

// translate converts a girc.Event into our wire-level Event.
func translate(e girc.Event) Event {
	out := Event{Kind: e.Command, Raw: e.String()}
	if e.Source != nil {
		out.From = e.Source.Name
		out.Host = e.Source.Host
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
	// account-tag carries the sender's services account on each message.
	// Specific cases (JOIN extended-join, ACCOUNT) may override below.
	out.Account = normalizeAccount(e.Tags["account"])
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
		// extended-join: JOIN <channel> <account> :<realname>. Param[1] is
		// the joiner's account ("*" when not identified). Authoritative over
		// the tag for the join moment (also gives us our OWN account on
		// self-join). Plain JOIN has only the channel param, so this no-ops.
		if e.Command == girc.JOIN && len(e.Params) >= 2 {
			out.Account = normalizeAccount(e.Params[1])
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
			// A *user* mode change (target is a nick, not a channel) that
			// adds +o means we just became an IRC operator — the server only
			// sends a user's mode changes to that user themselves. Channel
			// +o (op) targets a channel and must NOT count. The renderer
			// double-checks Target == our nick before trusting it.
			if !isChannelName(out.Target) && grantsOper(e.Params[1]) {
				out.IsOper = true
			}
		}
	case girc.RPL_YOUREOPER:
		// 381 :You are now an IRC operator. Authoritative self-oper signal.
		out.IsOper = true
		out.Message = e.Last()
	case girc.RPL_WHOREPLY:
		// 352 mynick #channel ident host server nick H|G[@%+...] :hopcount realname
		// Used here to retroactively detect users who were already away
		// when we joined the channel (the away-notify CAP only pushes
		// state CHANGES, not the current state at join). Status field is
		// 'H' here / 'G' gone (away), followed by optional sigils.
		if len(e.Params) >= 7 {
			out.Target = e.Params[1]         // channel
			out.Host = e.Params[3]           // host — for presence matching
			out.From = e.Params[5]           // nick
			out.Args = []string{e.Params[6]} // status flags
			slog.Info("irc: forwarding RPL_WHOREPLY",
				"channel", out.Target, "nick", out.From, "flags", e.Params[6])
		} else {
			slog.Warn("irc: 352 too short", "params", e.Params)
		}
		out.Message = e.Last()
	case "ACCOUNT":
		// account-notify: :nick ACCOUNT <account>  ("*" = logged out). Lets
		// the renderer keep a member's account live without a re-WHO.
		if len(e.Params) >= 1 {
			out.Account = normalizeAccount(e.Params[0])
		}
	case "CHGHOST":
		// :nick!user@host CHGHOST <newuser> <newhost> — push the new host so
		// presence matching tracks cloak/vhost changes.
		if len(e.Params) >= 2 {
			out.Host = e.Params[1]
			out.Args = append([]string(nil), e.Params...)
		}
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
		// Forward every 3-digit numeric reply — the explicit cases
		// above handle the ones that need parsing (welcome, ISUPPORT,
		// NAMES, TOPIC, MOTD, WHO, AWAY); everything else (the bulk
		// of RPL_*/ERR_* — LUSERS 251-255, VERSION 351, ADMIN 256-259,
		// TIME 391, LINKS 364/365, WHOIS 311-319, WHOWAS 314/369,
		// INFO 371/374, plus all 4xx/5xx error numerics) flows
		// through with just Message populated. The renderer treats
		// them all uniformly: surface in the ~server log and capture
		// inline in the Advanced panel.
		//
		// Without this, slash commands like /lusers, /version, /admin,
		// /time, /links, /whois, /whowas just silently swallow their
		// reply — the engine drops it, the renderer shows nothing.
		if len(e.Command) == 3 && e.Command[0] >= '0' && e.Command[0] <= '9' {
			out.Message = e.Last()
			// Carry remaining params too — some replies pack data
			// across multiple positional params (e.g. RPL_WHOISUSER
			// is `<mynick> <nick> <user> <host> * :realname`). The
			// renderer can stringify Args when Message alone isn't
			// enough.
			if len(e.Params) > 1 {
				out.Args = append([]string(nil), e.Params[1:]...)
			}
			return out
		}
		return Event{}
	}
	return out
}
