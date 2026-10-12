package irc

// The bouncer upstream state: does the app say "connected" exactly when the
// bouncer's upstream network is up? Three layers:
//
//   - isUpstreamEvidence: which wire lines prove the upstream is there;
//   - bouncerState: how evidence, the USERHOST probe, *status text and the
//     user's own connect/disconnect combine (timers fired by hand);
//   - a real Client against a scripted ZNC, replaying whole attaches as
//     they happen in the field (IRCForever's hosted ZNC on Rizon: its own
//     welcome notices, then the app's join burst stuck in ZNC's flood queue).

import (
	"fmt"
	"testing"
	"time"

	"github.com/lrstanley/girc"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// ---------------------------------------------------------------------------
// isUpstreamEvidence
// ---------------------------------------------------------------------------

func TestIsUpstreamEvidence(t *testing.T) {
	cases := []struct {
		raw  string
		want bool
		why  string
	}{
		// The network's server answering: only it can.
		{":irc6.rizon.net 353 tester = #chan :tester @bob", true, "NAMES"},
		{":irc6.rizon.net 366 tester #chan :End of /NAMES list.", true, "end of NAMES"},
		{":irc6.rizon.net 332 tester #chan :the topic", true, "TOPIC"},
		{":irc6.rizon.net 333 tester #chan bob 1700000000", true, "topic setter"},
		{":irc6.rizon.net 324 tester #chan +nt", true, "channel modes"},
		{":irc6.rizon.net 352 tester #chan ~b host irc6.rizon.net bob H :0 Bob", true, "WHO reply"},
		{":irc6.rizon.net 315 tester #chan :End of /WHO list.", true, "end of WHO"},
		{":irc6.rizon.net 302 tester :tester=+~t@host", true, "USERHOST (the probe's answer)"},
		{":irc6.rizon.net 005 tester NETWORK=Rizon :are supported", true, "ISUPPORT replayed on attach while connected"},
		{":irc6.rizon.net 375 tester :- MOTD -", true, "MOTD"},
		{":irc6.rizon.net 401 tester nobody :No such nick", true, "an error from the network is still the network"},
		{":irc6.rizon.net 001 tester :Welcome to Rizon", false, "001 is onWelcome's (it re-arms the session)"},
		// Other people on the network.
		{":bob!b@host PRIVMSG #chan :hi", true, "a channel message"},
		{":bob!b@host PRIVMSG tester :psst", true, "a private message"},
		{":bob!b@host NOTICE tester :hi", true, "a notice"},
		{":bob!b@host JOIN #chan", true, "someone joining"},
		{":bob!b@host JOIN #chan bob :Bob", true, "extended-join"},
		{":bob!b@host PART #chan :bye", true, "someone leaving"},
		{":bob!b@host QUIT :Ping timeout", true, "someone quitting"},
		{":bob!b@host NICK bobby", true, "a nick change"},
		{":bob!b@host MODE #chan +o tester", true, "a mode change"},
		{":bob!b@host TOPIC #chan :new", true, "a topic change"},
		{":bob!b@host KICK #chan carol :out", true, "a kick"},
		{":bob!b@host AWAY :lunch", true, "away-notify"},
		{":bob!b@host ACCOUNT bob", true, "account-notify"},
		{"@+typing=active :bob!b@host TAGMSG #chan", true, "a typing notification"},
		{":ChanServ!service@rizon.net NOTICE tester :Welcome to #chan", true, "services"},
		{":bob!b@host INVITE tester #secret", true, "an invite"},
		// Our own JOIN: the network echoes it.
		{":tester!t@host JOIN #chan", true, "our JOIN echo"},
		{":Tester!t@host JOIN #chan", true, "our JOIN echo, other case"},
		// What ZNC can produce by itself, connected or not.
		{":irc.znc.in 001 tester :Welcome to ZNC", false, "ZNC's synthetic welcome"},
		{":irc.znc.in 005 tester NETWORK=x :are supported", false, "ZNC's own numerics"},
		{":irc.znc.in 464 tester :Invalid Password", false, "ZNC's own errors"},
		{":irc.znc.in NOTICE tester :hi", false, "ZNC's notices"},
		{":*status!status@znc.in PRIVMSG tester :Welcome to IRCForever BNC's (bnc.ircforever.org).", false, "a hosted ZNC's welcome"},
		{":*status!status@znc.in NOTICE tester :For SSL connection use bnc.ircforever.org:31337", false, "a hosted ZNC's notice"},
		{":*controlpanel!controlpanel@znc.in PRIVMSG tester :Done", false, "another module"},
		{":other!tester8@irc.znc.in PRIVMSG *status :ListNetworks", false, "another client of the network, relayed by ZNC"},
		{":other!o@host PRIVMSG *status :ListNetworks", false, "anything to a module"},
		{"@batch=p :bob!b@host PRIVMSG #chan :old", false, "buffer playback"},
		{"@batch=p;time=2026-10-12T09:00:00.000Z :bob!b@host JOIN #chan", false, "buffer playback (buffextras)"},
		{":tester!t@host PRIVMSG #chan :me", false, "our own message (ZNC echoes it itself)"},
		{":tester!t@host NOTICE #chan :me", false, "our own notice"},
		{":tester!t@host NICK other", false, "our own nick change (ZNC can do it alone)"},
		{":tester!t@host PART #chan", false, "our own part"},
		{":tester!t@host QUIT :bye", false, "our own quit"},
		{":tester!t@host AWAY :brb", false, "our own away"},
		{":irc6.rizon.net NOTICE tester :*** Server notice", false, "server non-numerics: kept out"},
		{":irc6.rizon.net MODE tester +x", false, "server non-numerics: kept out"},
		{"PING :irc6.rizon.net", false, "no source"},
		{"ERROR :Closing link", false, "no source"},
	}
	for _, tc := range cases {
		t.Run(tc.why, func(t *testing.T) {
			e := girc.ParseEvent(tc.raw)
			require.NotNil(t, e, tc.raw)
			assert.Equal(t, tc.want, isUpstreamEvidence(*e, "tester"), tc.raw)
		})
	}
}

// ---------------------------------------------------------------------------
// bouncerState, timers fired by hand
// ---------------------------------------------------------------------------

// timers lets a test fire the captured timers one at a time.
func (e *fakeBouncerEnv) takeTimers() []func() {
	e.mu.Lock()
	defer e.mu.Unlock()
	ts := e.timers
	e.timers = nil
	return ts
}

func (e *fakeBouncerEnv) sentLines() []string {
	e.mu.Lock()
	defer e.mu.Unlock()
	return append([]string(nil), e.sent...)
}

// connectedBouncer: a declared bouncer whose upstream just came up.
func connectedBouncer(t *testing.T) (*bouncerState, *fakeBouncerEnv) {
	t.Helper()
	b, env := newFakeBouncer(true, false)
	require.True(t, b.onWelcome("irc6.rizon.net"))
	require.Equal(t, UpstreamConnected, b.snapshot())
	return b, env
}

// probe: an unrecognised status line while connected, then the probe delay
// fires and USERHOST goes out. Returns the probe-timeout timer.
func probe(t *testing.T, b *bouncerState, env *fakeBouncerEnv, statusLine string) func() {
	t.Helper()
	b.onStatusMessage("*status", statusLine)
	delay := env.takeTimers()
	require.Len(t, delay, 1, "the probe delay")
	delay[0]()
	require.Contains(t, env.sentLines(), "USERHOST tester")
	timeout := env.takeTimers()
	require.Len(t, timeout, 1, "the probe timeout")
	return timeout[0]
}

const hostedWelcome = "Welcome to IRCForever BNC's (bnc.ircforever.org)."

func TestBouncerState_ProbeAnsweredStaysConnected(t *testing.T) {
	b, env := connectedBouncer(t)
	timeout := probe(t, b, env, hostedWelcome)
	assert.True(t, b.onUserhostReply(), "our probe's 302 is consumed")
	timeout()
	assert.Equal(t, UpstreamConnected, b.snapshot())
	assert.Equal(t, []BouncerUpstream{UpstreamConnected}, env.states)
}

func TestBouncerState_ProbeSilenceMeansDisconnected(t *testing.T) {
	b, env := connectedBouncer(t)
	timeout := probe(t, b, env, hostedWelcome)
	timeout()
	assert.Equal(t, UpstreamDisconnected, b.snapshot())
	assert.Equal(t, []BouncerUpstream{UpstreamConnected, UpstreamDisconnected}, env.states)
}

// The field bug: the probe's reply sits in ZNC's flood queue behind the
// app's join burst, but the joins' replies already stream back.
func TestBouncerState_ProbeUnansweredButNetworkTalkingStaysConnected(t *testing.T) {
	b, env := connectedBouncer(t)
	timeout := probe(t, b, env, hostedWelcome)
	b.onUpstreamEvidence() // a NAMES reply, say
	timeout()
	assert.Equal(t, UpstreamConnected, b.snapshot())
	assert.Equal(t, []BouncerUpstream{UpstreamConnected}, env.states)
	// The 302 arriving afterwards is still ours: consumed, state unchanged.
	assert.True(t, b.onUserhostReply())
	b.onUpstreamEvidence()
	assert.Equal(t, []BouncerUpstream{UpstreamConnected}, env.states)
}

// Evidence from before the probe went out says nothing about after.
func TestBouncerState_EvidenceBeforeTheProbeDoesNotCount(t *testing.T) {
	b, env := connectedBouncer(t)
	b.onUpstreamEvidence()
	b.onUpstreamEvidence()
	timeout := probe(t, b, env, hostedWelcome)
	timeout()
	assert.Equal(t, UpstreamDisconnected, b.snapshot())
}

// Found while writing these tests: an answered probe's timeout used to
// judge the NEXT probe (timeouts were keyed on the state epoch only), ending
// it early or, with evidence counting, clearing it unjudged.
func TestBouncerState_EachTimeoutJudgesOnlyItsOwnProbe(t *testing.T) {
	b, env := connectedBouncer(t)
	first := probe(t, b, env, hostedWelcome)
	require.True(t, b.onUserhostReply())
	b.onUpstreamEvidence()
	second := probe(t, b, env, "Verbinde zu rizon...")
	first() // the answered probe's timeout: must not touch the second probe
	assert.Equal(t, UpstreamConnected, b.snapshot())
	second() // the second probe, unanswered, silence since: down
	assert.Equal(t, UpstreamDisconnected, b.snapshot())
	assert.Equal(t, []BouncerUpstream{UpstreamConnected, UpstreamDisconnected}, env.states)
}

func TestBouncerState_LateReplyRecoversAndIsConsumed(t *testing.T) {
	b, env := connectedBouncer(t)
	probe(t, b, env, hostedWelcome)()
	require.Equal(t, UpstreamDisconnected, b.snapshot())
	// The upstream was there all along; its answer was just slow.
	// As the Client handles a 302: matched to the probe first, then counted.
	assert.True(t, b.onUserhostReply(), "a late answer to our probe is still ours")
	b.onUpstreamEvidence()
	assert.Equal(t, UpstreamConnected, b.snapshot())
	assert.Equal(t, []BouncerUpstream{UpstreamConnected, UpstreamDisconnected, UpstreamConnected}, env.states)
	// Only one reply per probe is swallowed: a USERHOST the user typed shows.
	assert.False(t, b.onUserhostReply())
}

func TestBouncerState_EvidenceAfterRecoveryDoesNotSwallowTheUsersUserhost(t *testing.T) {
	b, env := connectedBouncer(t)
	probe(t, b, env, hostedWelcome)()
	b.onUpstreamEvidence() // recovered by other traffic, the 302 never came
	require.Equal(t, UpstreamConnected, b.snapshot())
	assert.False(t, b.onUserhostReply(), "a later 302 is the user's own /userhost")
}

func TestBouncerState_EvidenceRecoversFromEveryWrongDown(t *testing.T) {
	for _, down := range []struct {
		name string
		do   func(b *bouncerState, env *fakeBouncerEnv)
	}{
		{"probe silence", func(b *bouncerState, env *fakeBouncerEnv) { probe(t, b, env, hostedWelcome)() }},
		{"connecting timeout", func(b *bouncerState, env *fakeBouncerEnv) {
			b.onStatusMessage("*status", "Disconnected from IRC. Reconnecting...")
			for _, fn := range env.takeTimers() {
				fn()
			}
		}},
		{"a misread status line", func(b *bouncerState, _ *fakeBouncerEnv) {
			b.onStatusMessage("*status", "Your message to #chan got lost, you are not connected to IRC!")
		}},
	} {
		t.Run(down.name, func(t *testing.T) {
			b, env := connectedBouncer(t)
			down.do(b, env)
			require.Equal(t, UpstreamDisconnected, b.snapshot())
			b.onUpstreamEvidence()
			assert.Equal(t, UpstreamConnected, b.snapshot())
		})
	}
}

func TestBouncerState_EvidenceWhileConnectingMeansConnected(t *testing.T) {
	b, env := newFakeBouncer(true, false)
	b.onWelcome(zncServerName)
	b.connect()
	require.Equal(t, UpstreamConnecting, b.snapshot())
	b.onUpstreamEvidence()
	assert.Equal(t, UpstreamConnected, b.snapshot())
	assert.Equal(t, []BouncerUpstream{UpstreamDisconnected, UpstreamConnecting, UpstreamConnected}, env.states)
}

func TestBouncerState_EvidenceNeverGuessesAnUnknownState(t *testing.T) {
	b, env := newFakeBouncer(true, false)
	b.onUpstreamEvidence()
	assert.Equal(t, BouncerUpstream(""), b.snapshot())
	assert.Empty(t, env.states)
}

func TestBouncerState_PlainServerNeverReports(t *testing.T) {
	b, env := newFakeBouncer(false, false)
	b.onWelcome("irc.libera.chat")
	b.onUpstreamEvidence()
	assert.Equal(t, BouncerUpstream(""), b.snapshot())
	assert.Empty(t, env.states)
}

// After the user's Disconnect, lines already on the wire from the upstream
// being dropped mustn't flip it back to connected.
func TestBouncerState_EvidenceMutedAfterUserDisconnect(t *testing.T) {
	b, env := connectedBouncer(t)
	b.disconnect()
	require.Equal(t, UpstreamDisconnected, b.snapshot())
	b.onUpstreamEvidence()
	b.onUpstreamEvidence()
	assert.Equal(t, UpstreamDisconnected, b.snapshot())
	assert.Equal(t, []BouncerUpstream{UpstreamConnected, UpstreamDisconnected}, env.states)

	// Connect again: evidence counts again.
	b.connect()
	require.Equal(t, UpstreamConnecting, b.snapshot())
	b.onUpstreamEvidence()
	assert.Equal(t, UpstreamConnected, b.snapshot())
}

func TestBouncerState_RealWelcomeUnmutesAfterUserDisconnect(t *testing.T) {
	b, _ := connectedBouncer(t)
	b.disconnect()
	// Another client of the same ZNC network connected it again.
	assert.True(t, b.onWelcome("irc6.rizon.net"))
	assert.Equal(t, UpstreamConnected, b.snapshot())
	b.onStatusMessage("*status", "Disconnected from IRC. Use 'connect' to reconnect.")
	require.Equal(t, UpstreamDisconnected, b.snapshot())
	b.onUpstreamEvidence()
	assert.Equal(t, UpstreamConnected, b.snapshot(), "not muted any more: only an explicit disconnect mutes")
}

func TestBouncerState_HostedWelcomeWhileConnectedOnlyProbes(t *testing.T) {
	b, env := connectedBouncer(t)
	for _, n := range []string{
		hostedWelcome,
		"For SSL connection use bnc.ircforever.org:31337",
		"For Non-SSL connection use bnc.ircforever.org:1337",
		"If you would like to get some support, mail us at support@ircforever.org",
	} {
		b.onStatusMessage("*status", n)
	}
	assert.Equal(t, UpstreamConnected, b.snapshot())
	timers := env.takeTimers()
	assert.Len(t, timers, 1, "one probe for the lot, not one each")
}

// ---------------------------------------------------------------------------
// A real Client against a scripted ZNC
// ---------------------------------------------------------------------------

// rizonAttach is what ZNC replays when a client attaches while its upstream
// is connected: the cached registration burst from the real server…
var rizonAttach = []string{
	":irc6.rizon.net 001 tester :Welcome to the Rizon Internet Relay Chat Network tester",
	":irc6.rizon.net 002 tester :Your host is irc6.rizon.net, running version plexus-4(hybrid-8.1.20)",
	":irc6.rizon.net 004 tester irc6.rizon.net plexus-4(hybrid-8.1.20) CDGNRSUWagilopqrswxyz BCIMNORSabcehiklmnopqstvz Iabehkloqv",
	":irc6.rizon.net 005 tester NETWORK=Rizon CASEMAPPING=rfc1459 :are supported by this server",
	":irc6.rizon.net 422 tester :MOTD File is missing",
}

// …then the hosted ZNC's own welcome.
var ircForeverNotices = []string{
	":*status!status@znc.in NOTICE tester :Welcome to IRCForever BNC's (bnc.ircforever.org).",
	":*status!status@znc.in NOTICE tester :For SSL connection use bnc.ircforever.org:31337",
	":*status!status@znc.in NOTICE tester :For Non-SSL connection use bnc.ircforever.org:1337",
	":*status!status@znc.in NOTICE tester :If you would like to get some support, mail us at support@ircforever.org",
}

// joinReplies is what the network sends back for one channel join.
func joinReplies(ch string) []string {
	return []string{
		fmt.Sprintf(":tester!t@rizon-ABC.example JOIN %s", ch),
		fmt.Sprintf(":irc6.rizon.net 332 tester %s :welcome to %s", ch, ch),
		fmt.Sprintf(":irc6.rizon.net 353 tester = %s :tester @op", ch),
		fmt.Sprintf(":irc6.rizon.net 366 tester %s :End of /NAMES list.", ch),
	}
}

// The reported bug, end to end. Attach while connected, the hosted ZNC's
// notices arm the probe, the probe's reply never makes it back before the
// timeout (stuck behind the app's join burst in ZNC's flood queue), but the
// joins' own replies keep arriving: the state must stay "connected".
func TestBouncer_HostedZncJoinBurstStaysConnected(t *testing.T) {
	_, srv, rec := startBouncerClient(t, func(c *Config) { c.Bouncer = true; c.BouncerAutoConnect = true })
	srv.send(rizonAttach...)
	rec.waitStates(t, UpstreamConnected)
	srv.send(ircForeverNotices...)
	// The probe goes out (and is never answered here).
	require.Eventually(t, func() bool { return srv.countPrefix("USERHOST ") == 1 }, 3*time.Second, 5*time.Millisecond)
	// Channels' replies trickle in across the whole probe timeout (250ms here).
	for i := 0; i < 8; i++ {
		srv.send(joinReplies(fmt.Sprintf("#chan%d", i))...)
		time.Sleep(50 * time.Millisecond)
	}
	settle()
	assert.Equal(t, []BouncerUpstream{UpstreamConnected}, rec.snapshot())
	assert.Zero(t, srv.count(lineConnect), "never asked ZNC to connect what was connected")
}

// Quiet channels, slow upstream: the probe times out with nothing else
// heard, so "disconnected" is right for now; the 302 turning up late puts
// it back, and is kept out of the server log.
func TestBouncer_LateUserhostRecovers(t *testing.T) {
	_, srv, rec := startBouncerClient(t, func(c *Config) { c.Bouncer = true })
	srv.send(rizonAttach...)
	rec.waitStates(t, UpstreamConnected)
	srv.send(ircForeverNotices[0])
	require.Eventually(t, func() bool { return srv.countPrefix("USERHOST ") == 1 }, 3*time.Second, 5*time.Millisecond)
	rec.waitStates(t, UpstreamConnected, UpstreamDisconnected)
	srv.send(":irc6.rizon.net 302 tester :tester=+~t@rizon-ABC.example")
	rec.waitStates(t, UpstreamConnected, UpstreamDisconnected, UpstreamConnected)
	settle()
	assert.Zero(t, rec.eventKinds(girc.RPL_USERHOST), "the probe's reply isn't shown")
}

// Each kind of evidence on its own recovers a wrong "disconnected".
func TestBouncer_EachKindOfEvidenceRecovers(t *testing.T) {
	for _, tc := range []struct{ name, line string }{
		{"our JOIN echo", ":tester!t@rizon-ABC.example JOIN #new"},
		{"a TOPIC reply", ":irc6.rizon.net 332 tester #chan :topic"},
		{"a NAMES reply", ":irc6.rizon.net 353 tester = #chan :tester bob"},
		{"a WHO reply", ":irc6.rizon.net 352 tester #chan ~b host irc6.rizon.net bob H :0 Bob"},
		{"someone joining", ":bob!b@host JOIN #chan"},
		{"someone quitting", ":bob!b@host QUIT :gone"},
		{"a mode change", ":ChanServ!service@rizon.net MODE #chan +o tester"},
		{"a message", ":bob!b@host PRIVMSG #chan :hi"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			_, srv, rec := startBouncerClient(t, func(c *Config) { c.Bouncer = true })
			srv.send(rizonAttach...)
			rec.waitStates(t, UpstreamConnected)
			srv.send(ircForeverNotices[0])
			rec.waitStates(t, UpstreamConnected, UpstreamDisconnected) // probe unanswered
			srv.send(tc.line)
			rec.waitStates(t, UpstreamConnected, UpstreamDisconnected, UpstreamConnected)
		})
	}
}

// While the upstream really is down, nothing ZNC can produce by itself may
// read as "connected".
func TestBouncer_ZncsOwnLinesNeverProveUpstream(t *testing.T) {
	_, srv, rec := startBouncerClient(t, func(c *Config) { c.Bouncer = true })
	srv.send(zncWelcome, zncCurrentlyDown)
	rec.waitStates(t, UpstreamDisconnected)
	srv.send(
		":irc.znc.in 005 tester NETWORK=Rizon :are supported by this server",
		":irc.znc.in NOTICE tester :something from ZNC",
		":*status!status@znc.in NOTICE tester :For SSL connection use bnc.ircforever.org:31337",
		":other!tester8@irc.znc.in PRIVMSG *status :ListNetworks",
		"@batch=pb :bob!b@host PRIVMSG #chan :buffered while you were away",
		":tester!t@host PRIVMSG #chan :my own echo",
		":tester!t@host NICK tester_",
	)
	settle()
	assert.Equal(t, []BouncerUpstream{UpstreamDisconnected}, rec.snapshot())
}

// The user's Disconnect sticks even if the upstream's last lines are still
// arriving; a real upstream welcome (another client reconnected it) is
// believed.
func TestBouncer_UserDisconnectSticksAgainstInFlightLines(t *testing.T) {
	c, srv, rec := startBouncerClient(t, func(c *Config) { c.Bouncer = true })
	srv.send(rizonAttach...)
	rec.waitStates(t, UpstreamConnected)
	c.BouncerDisconnect()
	rec.waitStates(t, UpstreamConnected, UpstreamDisconnected)
	srv.send(":bob!b@host PRIVMSG #chan :said just before the drop", ":irc6.rizon.net 353 tester = #chan :tester bob")
	settle()
	assert.Equal(t, []BouncerUpstream{UpstreamConnected, UpstreamDisconnected}, rec.snapshot())
	srv.send(rizonAttach[0])
	rec.waitStates(t, UpstreamConnected, UpstreamDisconnected, UpstreamConnected)
}

// A plain IRC server never gets a bouncer state, whatever it sends.
func TestBouncer_PlainServerNoStateFromEvidence(t *testing.T) {
	_, srv, rec := startBouncerClient(t, nil)
	srv.send(rizonAttach...)
	srv.send(joinReplies("#chan")...)
	settle()
	assert.Empty(t, rec.snapshot())
}
