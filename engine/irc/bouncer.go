// Bouncer (ZNC) upstream tracking.
//
// ZNC registers the client even while ZNC itself is NOT connected to the
// real IRC network ("upstream"). On attach it sends only a synthetic
// `:irc.znc.in 001 <nick> :Welcome to ZNC` plus a *status line, so treating
// that 001 as the network's welcome fires NickServ IDENTIFY, the services
// VERSION probes and the auto-LIST into the void (ZNC answers "Your message
// to NickServ got lost, you are not connected to IRC!"). Those are one-shot,
// so they never re-fire once the upstream does connect.
//
// bouncerState follows the upstream through ZNC's structural signals and
// tells the Client when an upstream session starts (a 001 from the real
// server name — ZNC forwards the upstream's whole registration burst live,
// and replays it from cache on attach-while-connected) so the welcome work
// runs then, re-armed per upstream session. Signals, strongest first:
//
//   - 001 source `irc.znc.in` ⇒ upstream disconnected (hardcoded in ZNC,
//     never translated).
//   - 001 from any other source ⇒ a new upstream session (connected).
//   - A live message from another user on the network ⇒ connected (ZNC
//     relays nothing from the network while its upstream is down).
//   - A message from `<prefix>status!status@znc.in` (the prefix is the
//     user's StatusPrefix setting, default `*`) ⇒ "state may have changed".
//     English text is matched as a fast path; anything unrecognised while
//     we believe the upstream is up triggers a `USERHOST <ownnick>` probe,
//     which the upstream answers (302) only while connected — ZNC silently
//     drops it otherwise. That keeps localized ZNCs working.
//
// Empirical wire logs backing all of this: ZNC 1.9.1 lab report
// (znc-behaviour.md, sections A–H).

package irc

import (
	"strings"
	"sync"
	"time"
)

// BouncerUpstream is the bouncer's upstream connection state as reported to
// the renderer. The empty value means "not known yet" and is never emitted.
type BouncerUpstream string

const (
	UpstreamConnected    BouncerUpstream = "connected"
	UpstreamDisconnected BouncerUpstream = "disconnected"
	UpstreamConnecting   BouncerUpstream = "connecting"
)

// BouncerUpstreamHandler fires on every (deduped) upstream state change of
// a connection that is a bouncer (declared via Config.Bouncer or detected).
type BouncerUpstreamHandler func(BouncerUpstream)

const (
	// zncServerName is the hardcoded source ZNC uses for its own replies
	// (CAP, PONG, and the synthetic 001 when the upstream is down).
	zncServerName = "irc.znc.in"
	// The *status bot's ident@host. The nick prefix is configurable
	// (StatusPrefix), so match the ident/host and remember the nick.
	zncStatusIdent = "status"
	zncStatusHost  = "znc.in"
	// defaultStatusNick addresses the status bot until we've seen it speak.
	defaultStatusNick = "*status"

	// bouncerProbeDelay is how long after an ambiguous *status message we
	// wait before sending the USERHOST self-probe. ZNC was observed to drop
	// USERHOST sent within ~5s of an upstream (re)connect, and an upstream
	// 001 arriving in this window settles the state on its own anyway.
	bouncerProbeDelay = 5 * time.Second
	// bouncerProbeTimeout is how long we wait for the 302 before deciding
	// the upstream is down (ZNC drops USERHOST silently when disconnected).
	bouncerProbeTimeout = 5 * time.Second
	// bouncerConnectingTimeout bounds the `connecting` state. ZNC throttles
	// reconnects silently (ServerThrottle, default 30s), so a `connect` can
	// produce no further output at all; fall back to `disconnected` rather
	// than spinning forever.
	bouncerConnectingTimeout = 60 * time.Second
	// bouncerAutoConnectGrace: auto-connect waits for the *status line ZNC
	// sends right after its synthetic 001, because that line tells us the
	// status bot's actual nick (StatusPrefix is configurable — `connect` sent
	// to a non-existent `*status` would go upstream and be lost). If no
	// status line shows up within this window, fall back to the default.
	bouncerAutoConnectGrace = 2 * time.Second
)

// bouncerState is the per-Client upstream tracker. Like servicesState it
// takes its side effects as injected callbacks so it can be driven in
// isolation; the Client wires them to girc and afterConnLifetime.
//
// State is tracked for every connection (a plain IRC server just sits at
// "connected" after its 001), but only *emitted*, and only acted on
// (auto-connect, probes), once the connection is a bouncer — declared by
// the renderer or detected from the wire. That keeps non-bouncer servers'
// behaviour byte-for-byte unchanged.
type bouncerState struct {
	mu sync.Mutex

	declared    bool // Config.Bouncer — renderer routed this via a bouncer profile
	autoConnect bool // Config.BouncerAutoConnect
	detected    bool // seen irc.znc.in 001 or a status@znc.in message

	state      BouncerUpstream
	emitted    BouncerUpstream // last value passed to onChange (dedupe)
	statusNick string

	// autoConnectFired latches the attach-time `connect` to once per engine
	// connection; userWantsDown is set by an explicit bouncer-disconnect and
	// vetoes auto-connect for the rest of the connection.
	autoConnectFired bool
	userWantsDown    bool
	// autoConnectPending: the attach-time auto-connect is decided but held
	// until the status bot speaks (or the grace timer runs out).
	autoConnectPending bool

	// epoch is bumped on every state transition and on every 001. Deferred
	// work (probe, probe timeout, connecting timeout) captures it when
	// scheduled and does nothing if it changed: a newer, more authoritative
	// signal has already settled the state.
	epoch uint64
	// probeScheduled dedupes the delayed probe; probeInFlight is set while
	// we wait for the 302 so the reply can be consumed rather than shown.
	probeScheduled bool
	probeInFlight  bool

	// Timings, overridable by tests.
	probeDelay        time.Duration
	probeTimeout      time.Duration
	connectingTimeout time.Duration
	autoConnectGrace  time.Duration

	// Injected side effects. send queues a raw line with its send class
	// (status-bot connect/disconnect are interactive, the USERHOST probe is
	// background); after schedules fn on
	// the connection lifetime; selfNick returns our current nick; rearm
	// re-arms the per-upstream-session welcome latches (IDENTIFY, services
	// probe, auto-LIST). onChange must not block — the Client routes it
	// through the dispatch queue — because it is invoked under mu so that
	// emissions stay in transition order.
	send     func(line string, class sendClass)
	after    func(d time.Duration, fn func())
	selfNick func() string
	rearm    func()
	onChange func(BouncerUpstream)
}

func newBouncerState(declared, autoConnect bool) *bouncerState {
	return &bouncerState{
		declared:          declared,
		autoConnect:       autoConnect,
		statusNick:        defaultStatusNick,
		probeDelay:        bouncerProbeDelay,
		probeTimeout:      bouncerProbeTimeout,
		connectingTimeout: bouncerConnectingTimeout,
		autoConnectGrace:  bouncerAutoConnectGrace,
	}
}

func (b *bouncerState) setOnChange(fn func(BouncerUpstream)) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.onChange = fn
}

// snapshot returns the current upstream state ("" when unknown or when the
// connection isn't a bouncer).
func (b *bouncerState) snapshot() BouncerUpstream {
	b.mu.Lock()
	defer b.mu.Unlock()
	if !b.isBouncerLocked() {
		return ""
	}
	return b.state
}

func (b *bouncerState) isBouncerLocked() bool { return b.declared || b.detected }

// isStatusSource reports whether a message prefix is ZNC's status bot,
// whatever StatusPrefix the user configured.
func isStatusSource(ident, host string) bool {
	return ident == zncStatusIdent && strings.EqualFold(host, zncStatusHost)
}

// setLocked records a transition and emits it when this is a bouncer.
// Returns true when the state actually changed. Caller holds mu.
func (b *bouncerState) setLocked(s BouncerUpstream) bool {
	if b.state == s {
		return false
	}
	b.state = s
	b.epoch++
	b.probeScheduled = false
	b.probeInFlight = false
	b.emitLocked()
	return true
}

// emitLocked pushes the current state to onChange if it differs from the
// last emission. Also called when detection flips on, so the renderer learns
// the state we were already tracking silently. Caller holds mu.
func (b *bouncerState) emitLocked() {
	if !b.isBouncerLocked() || b.state == "" || b.state == b.emitted {
		return
	}
	b.emitted = b.state
	if b.onChange != nil {
		b.onChange(b.state)
	}
}

// post collects side effects decided under mu and runs them after it is
// released: sends can block on girc's tx queue, and rearm/after take other
// locks, so neither may run while holding mu.
type bouncerPost []func()

func (p bouncerPost) run() {
	for _, fn := range p {
		fn()
	}
}

// enterDisconnectedLocked moves to disconnected and, on a real change,
// queues the per-upstream-session re-arm so IDENTIFY / auto-LIST (and the
// services probe, if still unclassified) fire again on the next upstream 001.
func (b *bouncerState) enterDisconnectedLocked(post *bouncerPost) {
	if b.setLocked(UpstreamDisconnected) && b.rearm != nil {
		*post = append(*post, b.rearm)
	}
}

// enterConnectingLocked moves to connecting and arms the fallback timer.
func (b *bouncerState) enterConnectingLocked(post *bouncerPost) {
	if !b.setLocked(UpstreamConnecting) {
		return
	}
	epoch := b.epoch
	d := b.connectingTimeout
	*post = append(*post, func() {
		b.schedule(d, func() {
			b.mu.Lock()
			var p bouncerPost
			if b.epoch == epoch && b.state == UpstreamConnecting {
				b.enterDisconnectedLocked(&p)
			}
			b.mu.Unlock()
			p.run()
		})
	})
}

func (b *bouncerState) schedule(d time.Duration, fn func()) {
	if b.after != nil {
		b.after(d, fn)
	}
}

func (b *bouncerState) sendLine(line string, class sendClass) {
	if b.send != nil {
		b.send(line, class)
	}
}

// isBouncer reports whether this connection is (declared or detected as) a
// bouncer. Picks the send queue's pacing profile.
func (b *bouncerState) isBouncer() bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.isBouncerLocked()
}

// onWelcome handles 001 RPL_WELCOME and reports whether the Client should
// run its normal welcome work (auto-LIST, IDENTIFY, services probe). It is
// false only for ZNC's synthetic 001, which means the upstream is down and
// anything addressed to the network would be dropped.
//
// For a bouncer, every real-server 001 is a fresh upstream session (ZNC
// forwards each upstream registration live), so the welcome latches are
// re-armed before the work runs. Plain servers keep the old one-shot
// latching, which guards against girc's occasional 001 re-emits.
func (b *bouncerState) onWelcome(source string) (runWelcomeWork bool) {
	var post bouncerPost
	defer func() { post.run() }()
	b.mu.Lock()
	defer b.mu.Unlock()

	b.epoch++ // a 001 is authoritative: cancel pending probes / timeouts
	b.probeScheduled = false
	b.probeInFlight = false

	if strings.EqualFold(source, zncServerName) {
		b.detected = true
		b.enterDisconnectedLocked(&post)
		b.emitLocked() // in case state was already disconnected but unemitted
		if b.autoConnect && !b.autoConnectFired && !b.userWantsDown {
			b.autoConnectFired = true
			b.autoConnectPending = true
			grace := b.autoConnectGrace
			post = append(post, func() {
				b.schedule(grace, func() {
					var p bouncerPost
					b.mu.Lock()
					b.fireAutoConnectLocked(&p)
					b.mu.Unlock()
					p.run()
				})
			})
		}
		return false
	}

	wasBouncer := b.isBouncerLocked()
	b.setLocked(UpstreamConnected)
	if wasBouncer && b.rearm != nil {
		// Must run before the Client's welcome work, which happens after we
		// return — post runs in our deferred func, i.e. before that.
		post = append(post, b.rearm)
	}
	return true
}

// fireAutoConnectLocked sends the held attach-time `connect`, if it is still
// wanted: not vetoed by a bouncer-disconnect in the meantime, and the
// upstream still known to be down (ZNC may be reconnecting on its own).
func (b *bouncerState) fireAutoConnectLocked(post *bouncerPost) {
	if !b.autoConnectPending {
		return
	}
	b.autoConnectPending = false
	if b.userWantsDown || b.state != UpstreamDisconnected {
		return
	}
	line := "PRIVMSG " + b.statusNick + " :connect"
	*post = append(*post, func() { b.sendLine(line, classInteractive) })
	b.enterConnectingLocked(post)
}

// onStatusMessage handles a PRIVMSG/NOTICE from `<prefix>status!status@znc.in`.
func (b *bouncerState) onStatusMessage(nick, body string) {
	var post bouncerPost
	defer func() { post.run() }()
	b.mu.Lock()
	defer b.mu.Unlock()

	if nick != "" {
		b.statusNick = nick
	}
	if !b.detected {
		b.detected = true
		// Announce whatever we'd been tracking silently (e.g. a ZNC attach
		// while connected looks exactly like a plain server's 001).
		b.emitLocked()
	}

	switch {
	case strings.Contains(body, "You are currently disconnected"):
		// ZNC sends this right after the attach-time 001, and in reply to
		// `disconnect` while a connect is pending. It doesn't mean a
		// `connecting` upstream gave up (bouncer-disconnect already moved us
		// to disconnected itself), so it only moves other states; the
		// connecting timeout covers a connect that never lands.
		if b.state != UpstreamConnecting {
			b.enterDisconnectedLocked(&post)
		}
	case strings.Contains(body, "Disconnected from IRC"),
		strings.Contains(body, "you are not connected to IRC"):
		// Explicit disconnect, a dropped upstream ("Reconnecting..." — ZNC
		// retries on its own and the next 001 flips us back), or ZNC
		// bouncing a message we sent into a dead upstream.
		b.enterDisconnectedLocked(&post)
	case strings.Contains(body, "Connected!"), strings.Contains(body, "Connecting to "):
		// Upstream registration is under way; the 001 that follows is the
		// authoritative "connected". Precedes the 001 on the wire, so never
		// downgrade an already-connected state on it.
		if b.state != UpstreamConnected {
			b.enterConnectingLocked(&post)
		}
	default:
		// Unrecognised (localized ZNC, or just a reply to a user command).
		// If we believe the upstream is up, verify with a USERHOST probe.
		if b.state == UpstreamConnected || b.state == UpstreamConnecting {
			b.scheduleProbeLocked(&post)
		}
	}
	// Now that we know the status bot's nick (and have applied what it
	// said), release a held attach-time auto-connect.
	b.fireAutoConnectLocked(&post)
}

// scheduleProbeLocked arms the delayed USERHOST self-probe, once.
func (b *bouncerState) scheduleProbeLocked(post *bouncerPost) {
	if b.probeScheduled || b.probeInFlight {
		return
	}
	b.probeScheduled = true
	epoch := b.epoch
	delay, timeout := b.probeDelay, b.probeTimeout
	*post = append(*post, func() {
		b.schedule(delay, func() { b.fireProbe(epoch, timeout) })
	})
}

func (b *bouncerState) fireProbe(epoch uint64, timeout time.Duration) {
	b.mu.Lock()
	if b.epoch != epoch || !b.probeScheduled {
		b.mu.Unlock()
		return
	}
	b.probeScheduled = false
	b.probeInFlight = true
	b.mu.Unlock()

	nick := ""
	if b.selfNick != nil {
		nick = b.selfNick()
	}
	// Interactive, so the probe can't sit behind queued background lines
	// past its own timeout and misreport a busy upstream as down.
	b.sendLine("USERHOST "+nick, classInteractive)
	b.schedule(timeout, func() {
		b.mu.Lock()
		var p bouncerPost
		if b.epoch == epoch && b.probeInFlight {
			// Silence: ZNC dropped the probe, so nothing is upstream.
			b.probeInFlight = false
			b.enterDisconnectedLocked(&p)
		}
		b.mu.Unlock()
		p.run()
	})
}

// onUserhostReply handles 302 RPL_USERHOST. Returns true when it answered
// our own probe, in which case the Client swallows it so a periodic probe
// doesn't litter the renderer's server log.
func (b *bouncerState) onUserhostReply() (consumed bool) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if !b.probeInFlight {
		return false
	}
	b.probeInFlight = false
	// Only the upstream answers USERHOST, so a reply proves it's up.
	b.setLocked(UpstreamConnected)
	return true
}

// onUpstreamTraffic handles a live (un-batched) message from another user on
// the network. ZNC relays those only while its upstream is up, so it proves
// "connected" — recovering from a probe whose answer came too late, without
// waiting for the next *status line.
func (b *bouncerState) onUpstreamTraffic() {
	b.mu.Lock()
	defer b.mu.Unlock()
	if !b.isBouncerLocked() || b.state == UpstreamConnected || b.state == "" {
		return
	}
	b.setLocked(UpstreamConnected)
}

// connect implements the bouncer-connect command: ask the status bot to
// connect, unless the upstream is already up (`connect` while connected
// bounces the upstream connection in ZNC).
func (b *bouncerState) connect() {
	var post bouncerPost
	b.mu.Lock()
	if b.state != UpstreamConnected {
		line := "PRIVMSG " + b.statusNick + " :connect"
		post = append(post, func() { b.sendLine(line, classInteractive) })
		b.enterConnectingLocked(&post)
	}
	b.mu.Unlock()
	post.run()
}

// disconnect implements the bouncer-disconnect command. The state flips to
// disconnected immediately: ZNC's `disconnect` is synchronous and its
// confirmation is translatable, and a pending connect gets the ambiguous
// "You are currently disconnected" reply instead. It also vetoes
// auto-connect for the rest of this engine connection.
func (b *bouncerState) disconnect() {
	var post bouncerPost
	b.mu.Lock()
	b.userWantsDown = true
	line := "PRIVMSG " + b.statusNick + " :disconnect"
	post = append(post, func() { b.sendLine(line, classInteractive) })
	b.enterDisconnectedLocked(&post)
	b.mu.Unlock()
	post.run()
}
