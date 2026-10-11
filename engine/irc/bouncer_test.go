package irc

import (
	"bufio"
	"context"
	"net"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/lrstanley/girc"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// Raw ZNC 1.9.1 lines, verbatim from the lab report (znc-behaviour.md) except
// that @time tags are dropped. Nick is "tester" throughout.
const (
	zncWelcome         = ":irc.znc.in 001 tester :Welcome to ZNC"
	zncCurrentlyDown   = ":*status!status@znc.in PRIVMSG tester :You are currently disconnected from IRC. Use 'connect' to reconnect."
	zncConnectingTo    = ":*status!status@znc.in PRIVMSG tester :Connecting to ergo..."
	zncConnected       = ":*status!status@znc.in PRIVMSG tester :Connected!"
	zncDroppedRetrying = ":*status!status@znc.in PRIVMSG tester :Disconnected from IRC. Reconnecting..."
	zncConnRefused     = ":*status!status@znc.in PRIVMSG tester :Connection Refused.  Reconnecting..."
	zncUserDisconnect  = ":*status!status@znc.in PRIVMSG tester :Disconnected from IRC. Use 'connect' to reconnect."
	// Localized (de-DE) status text, from log-L-de.txt — matches none of the
	// English fast paths, so it exercises the USERHOST probe.
	zncGermanLine = ":*status!status@znc.in PRIVMSG tester :Du bist zur Zeit nicht mit dem IRC verbunden. Verwende 'connect' zum Verbinden."
	zncGermanMisc = ":*status!status@znc.in PRIVMSG tester :Verbinde zu ergo..."
)

// upstreamBurst is the upstream registration burst ZNC forwards live when
// the upstream (re)connects, and replays from cache on attach-while-connected.
var upstreamBurst = []string{
	":ergo.test 001 tester :Welcome to the BosonTest IRC Network tester",
	":ergo.test 002 tester :Your host is ergo.test, running version ergo-2.19.1-63c743a70644f0f1",
	":ergo.test 003 tester :This server was created Sat, 10 Oct 2026 13:57:32 UTC",
	":ergo.test 004 tester ergo.test ergo-2.19.1-63c743a70644f0f1 BERTZios CEIMRUabefhiklmnoqstuv Iabefhkloqv",
	":ergo.test 005 tester AWAYLEN=390 BOT=B CASEMAPPING=ascii NETWORK=BosonTest NICKLEN=32 :are supported by this server",
	":ergo.test 422 tester :MOTD File is missing",
}

// scriptedIRCServer is an interactive fake: it records every line the client
// sends and lets the test push server lines at any point, so a test can play
// out a bouncer's upstream connecting and dropping in sequence.
type scriptedIRCServer struct {
	t        *testing.T
	listener net.Listener
	port     int

	mu         sync.Mutex
	conn       net.Conn
	received   []string
	registered chan struct{} // closed once the client has sent USER
}

func newScriptedIRCServer(t *testing.T) *scriptedIRCServer {
	t.Helper()
	l, err := net.Listen("tcp", "127.0.0.1:0")
	require.NoError(t, err)
	s := &scriptedIRCServer{
		t:          t,
		listener:   l,
		port:       l.Addr().(*net.TCPAddr).Port,
		registered: make(chan struct{}),
	}
	var wg sync.WaitGroup
	wg.Add(1)
	go func() {
		defer wg.Done()
		cn, err := l.Accept()
		if err != nil {
			return
		}
		s.mu.Lock()
		s.conn = cn
		s.mu.Unlock()
		sc := bufio.NewScanner(cn)
		var once sync.Once
		for sc.Scan() {
			line := strings.TrimRight(sc.Text(), "\r")
			s.mu.Lock()
			s.received = append(s.received, line)
			s.mu.Unlock()
			if strings.HasPrefix(line, "USER ") {
				once.Do(func() { close(s.registered) })
			}
		}
	}()
	t.Cleanup(func() {
		_ = l.Close()
		s.mu.Lock()
		if s.conn != nil {
			_ = s.conn.Close()
		}
		s.mu.Unlock()
		wg.Wait()
	})
	return s
}

// send writes server lines once the client has registered.
func (s *scriptedIRCServer) send(lines ...string) {
	s.t.Helper()
	select {
	case <-s.registered:
	case <-time.After(5 * time.Second):
		s.t.Fatal("client never registered")
	}
	s.mu.Lock()
	cn := s.conn
	s.mu.Unlock()
	for _, l := range lines {
		_, err := cn.Write([]byte(l + "\r\n"))
		require.NoError(s.t, err)
	}
}

// count returns how many received lines equal line exactly.
func (s *scriptedIRCServer) count(line string) int {
	s.mu.Lock()
	defer s.mu.Unlock()
	n := 0
	for _, l := range s.received {
		if l == line {
			n++
		}
	}
	return n
}

func (s *scriptedIRCServer) countPrefix(prefix string) int {
	s.mu.Lock()
	defer s.mu.Unlock()
	n := 0
	for _, l := range s.received {
		if strings.HasPrefix(l, prefix) {
			n++
		}
	}
	return n
}

func (s *scriptedIRCServer) waitCount(line string, n int) {
	s.t.Helper()
	defer func() {
		if s.t.Failed() {
			s.mu.Lock()
			s.t.Logf("received: %q", s.received)
			s.mu.Unlock()
		}
	}()
	require.Eventually(s.t, func() bool { return s.count(line) >= n },
		3*time.Second, 5*time.Millisecond, "never received %d× %q", n, line)
}

// Lines the welcome work sends, as girc writes them.
const (
	lineIdentify = "PRIVMSG NickServ :IDENTIFY s3cret"
	lineVersion  = "PRIVMSG NickServ VERSION"
	lineList     = "LIST"
	lineConnect  = "PRIVMSG *status connect"
)

// upstreamRecorder captures OnBouncerUpstream deliveries and forwarded events.
type upstreamRecorder struct {
	mu     sync.Mutex
	states []BouncerUpstream
	events []Event
}

func (r *upstreamRecorder) onUpstream(u BouncerUpstream) {
	r.mu.Lock()
	r.states = append(r.states, u)
	r.mu.Unlock()
}

func (r *upstreamRecorder) onEvent(e Event) {
	r.mu.Lock()
	r.events = append(r.events, e)
	r.mu.Unlock()
}

func (r *upstreamRecorder) snapshot() []BouncerUpstream {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]BouncerUpstream(nil), r.states...)
}

func (r *upstreamRecorder) eventKinds(kind string) int {
	r.mu.Lock()
	defer r.mu.Unlock()
	n := 0
	for _, e := range r.events {
		if e.Kind == kind {
			n++
		}
	}
	return n
}

func (r *upstreamRecorder) waitStates(t *testing.T, want ...BouncerUpstream) {
	t.Helper()
	require.Eventually(t, func() bool { return len(r.snapshot()) >= len(want) },
		3*time.Second, 5*time.Millisecond, "states so far: %v, want %v", r.snapshot(), want)
	assert.Equal(t, want, r.snapshot())
}

// startBouncerClient connects a Client with shortened bouncer timings to a
// scripted server. mutate tweaks the Config before New.
func startBouncerClient(t *testing.T, mutate func(*Config)) (*Client, *scriptedIRCServer, *upstreamRecorder) {
	t.Helper()
	srv := newScriptedIRCServer(t)
	cfg := Config{Hostname: "127.0.0.1", Port: srv.port, Nick: "tester", NickservPassword: "s3cret"}
	if mutate != nil {
		mutate(&cfg)
	}
	c, err := New(cfg)
	require.NoError(t, err)
	// girc paces outbound lines (flood protection); the welcome work alone
	// is ~8 lines, which would make every step here take seconds.
	c.girc.Config.AllowFlood = true
	// Likewise the engine's own queue: bouncer pacing (ZNC's 2s a line) is
	// covered by the send-queue tests, not the upstream state machine.
	c.sendq.pacing = func() pacing { return pacing{} }
	c.autoListDelay = 10 * time.Millisecond
	c.bouncer.probeDelay = 30 * time.Millisecond
	c.bouncer.probeTimeout = 250 * time.Millisecond
	c.bouncer.connectingTimeout = 5 * time.Second
	c.bouncer.autoConnectGrace = 500 * time.Millisecond

	rec := &upstreamRecorder{}
	c.OnBouncerUpstream(rec.onUpstream)
	c.OnEvent(rec.onEvent)

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { defer close(done); _ = c.Connect(ctx) }()
	t.Cleanup(func() {
		cancel()
		<-done
	})
	return c, srv, rec
}

// settle waits long enough for the shortened auto-LIST / probe timers to
// have fired if they were (wrongly) armed.
func settle() { time.Sleep(150 * time.Millisecond) }

func TestBouncer_AttachWhileUpstreamDisconnected(t *testing.T) {
	cases := []struct {
		name         string
		autoConnect  bool
		wantStates   []BouncerUpstream
		wantConnects int
	}{
		{"no auto-connect", false, []BouncerUpstream{UpstreamDisconnected}, 0},
		// A held auto-connect reads "connecting" from the start: no Connect
		// button for the second before it is sent.
		{"auto-connect", true, []BouncerUpstream{UpstreamConnecting}, 1},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			// Bouncer deliberately NOT declared: the irc.znc.in 001 alone must
			// be enough to detect ZNC.
			_, srv, rec := startBouncerClient(t, func(c *Config) { c.BouncerAutoConnect = tc.autoConnect })
			srv.send(zncWelcome, zncCurrentlyDown)

			rec.waitStates(t, tc.wantStates...)
			settle()
			assert.Equal(t, tc.wantConnects, srv.count(lineConnect))
			assert.Zero(t, srv.count(lineIdentify), "IDENTIFY sent into a dead upstream")
			assert.Zero(t, srv.countPrefix(lineVersion), "services probe sent into a dead upstream")
			assert.Zero(t, srv.count(lineList), "auto-LIST sent into a dead upstream")
			assert.Equal(t, tc.wantStates, rec.snapshot())
		})
	}
}

func TestBouncer_UpstreamLifecycle(t *testing.T) {
	// Attach disconnected with auto-connect → upstream connects → drops →
	// ZNC reconnects it. The welcome work must run once per upstream session
	// and never against ZNC's synthetic 001; auto-connect fires only once.
	_, srv, rec := startBouncerClient(t, func(c *Config) {
		c.Bouncer = true
		c.BouncerAutoConnect = true
	})

	// 1. Attach while ZNC has no upstream.
	srv.send(zncWelcome, zncCurrentlyDown)
	srv.waitCount(lineConnect, 1)
	rec.waitStates(t, UpstreamConnecting)
	assert.Zero(t, srv.count(lineIdentify))

	// 2. The upstream comes up: ZNC's "Connecting to"/"Connected!" then the
	// live upstream burst with a second 001 from the real server name.
	srv.send(zncConnectingTo, zncConnected)
	srv.send(upstreamBurst...)
	rec.waitStates(t, UpstreamConnecting, UpstreamConnected)
	srv.waitCount(lineIdentify, 1)
	srv.waitCount(lineVersion, 1)
	srv.waitCount(lineList, 1)

	// 3. The upstream drops; ZNC retries on its own.
	srv.send(zncDroppedRetrying, zncConnRefused)
	rec.waitStates(t, UpstreamConnecting, UpstreamConnected, UpstreamDisconnected)

	// ...and reconnects: everything per-session fires again.
	srv.send(zncConnected)
	srv.send(upstreamBurst...)
	rec.waitStates(t, UpstreamConnecting, UpstreamConnected,
		UpstreamDisconnected, UpstreamConnecting, UpstreamConnected)
	srv.waitCount(lineIdentify, 2)
	srv.waitCount(lineList, 2)
	// Still unclassified (nothing answered the probe), so it re-runs too.
	srv.waitCount(lineVersion, 2)

	settle()
	assert.Equal(t, 1, srv.count(lineConnect), "auto-connect must fire only at attach")
	assert.Equal(t, 2, srv.count(lineIdentify))
	assert.Equal(t, 2, srv.count(lineList))
}

func TestBouncer_AttachWhileUpstreamConnected(t *testing.T) {
	// ZNC replays the cached upstream burst (real server name) and sends no
	// *status line at all.
	_, srv, rec := startBouncerClient(t, func(c *Config) {
		c.Bouncer = true
		c.BouncerAutoConnect = true
	})
	srv.send(upstreamBurst...)
	rec.waitStates(t, UpstreamConnected)
	srv.waitCount(lineIdentify, 1)
	srv.waitCount(lineVersion, 1)
	srv.waitCount(lineList, 1)

	settle()
	assert.Equal(t, []BouncerUpstream{UpstreamConnected}, rec.snapshot())
	assert.Equal(t, 1, srv.count(lineIdentify))
	assert.Equal(t, 1, srv.count(lineVersion))
	assert.Equal(t, 1, srv.count(lineList))
	assert.Zero(t, srv.count(lineConnect), "connect while connected would bounce the upstream")
}

func TestBouncer_UndeclaredZNCDetectedFromStatusBot(t *testing.T) {
	// Attach-while-connected to an undeclared ZNC looks exactly like a plain
	// server. The first status@znc.in message detects it; the state tracked
	// so far is announced, then the message itself is applied.
	_, srv, rec := startBouncerClient(t, nil)
	srv.send(upstreamBurst...)
	srv.waitCount(lineIdentify, 1)
	settle()
	assert.Empty(t, rec.snapshot(), "nothing to report before ZNC is detected")

	srv.send(zncUserDisconnect)
	rec.waitStates(t, UpstreamConnected, UpstreamDisconnected)

	srv.send(zncConnected)
	srv.send(upstreamBurst...)
	rec.waitStates(t, UpstreamConnected, UpstreamDisconnected, UpstreamConnecting, UpstreamConnected)
	srv.waitCount(lineIdentify, 2)
}

func TestBouncer_ConnectDisconnectCommands(t *testing.T) {
	c, srv, rec := startBouncerClient(t, func(c *Config) {
		c.Bouncer = true
		c.BouncerAutoConnect = true
	})
	srv.send(upstreamBurst...)
	rec.waitStates(t, UpstreamConnected)

	// bouncer-connect while connected: ZNC would bounce the upstream.
	c.BouncerConnect()
	settle()
	assert.Zero(t, srv.count(lineConnect))
	assert.Equal(t, []BouncerUpstream{UpstreamConnected}, rec.snapshot())

	// bouncer-disconnect: sent, reported at once, confirmation deduped.
	c.BouncerDisconnect()
	srv.waitCount("PRIVMSG *status disconnect", 1)
	rec.waitStates(t, UpstreamConnected, UpstreamDisconnected)
	srv.send(zncUserDisconnect)

	// A later synthetic welcome must not auto-connect: the user asked for
	// the upstream to stay down. (ZNC only sends it at attach; replayed here
	// to exercise the veto.)
	srv.send(zncWelcome, zncCurrentlyDown)
	time.Sleep(700 * time.Millisecond) // past the auto-connect grace
	assert.Zero(t, srv.count(lineConnect))
	assert.Equal(t, []BouncerUpstream{UpstreamConnected, UpstreamDisconnected}, rec.snapshot())

	// An explicit bouncer-connect still works.
	c.BouncerConnect()
	srv.waitCount(lineConnect, 1)
	rec.waitStates(t, UpstreamConnected, UpstreamDisconnected, UpstreamConnecting)
}

func TestBouncer_CustomStatusPrefix(t *testing.T) {
	// StatusPrefix "-": the bot is -status. Auto-connect is held until the
	// bot speaks, so it is addressed correctly even though the 001 comes
	// first.
	const welcome = ":irc.znc.in 001 tester :Welcome to ZNC"
	const down = ":-status!status@znc.in PRIVMSG tester :You are currently disconnected from IRC. Use 'connect' to reconnect."
	c, srv, rec := startBouncerClient(t, func(c *Config) { c.BouncerAutoConnect = true })
	srv.send(welcome, down)
	srv.waitCount("PRIVMSG -status connect", 1)
	rec.waitStates(t, UpstreamConnecting)
	assert.Zero(t, srv.count(lineConnect), "addressed the default *status")

	c.BouncerDisconnect()
	srv.waitCount("PRIVMSG -status disconnect", 1)
}

func TestBouncer_AutoConnectFallsBackWithoutStatusLine(t *testing.T) {
	// If no status line follows the synthetic 001, auto-connect still fires
	// after the grace window, to the default status nick.
	_, srv, rec := startBouncerClient(t, func(c *Config) { c.BouncerAutoConnect = true })
	srv.send(zncWelcome)
	rec.waitStates(t, UpstreamConnecting)
	srv.waitCount(lineConnect, 1)
	settle()
	assert.Equal(t, []BouncerUpstream{UpstreamConnecting}, rec.snapshot())
}

func TestBouncer_DisconnectDuringHeldAutoConnectReportsDisconnected(t *testing.T) {
	// The user hits Disconnect network in the second before the held
	// auto-connect is sent: it is called off and the state reads offline.
	c, srv, rec := startBouncerClient(t, func(c *Config) { c.BouncerAutoConnect = true })
	srv.send(zncWelcome)
	rec.waitStates(t, UpstreamConnecting)
	c.BouncerDisconnect()
	rec.waitStates(t, UpstreamConnecting, UpstreamDisconnected)
	settle()
	assert.Zero(t, srv.count(lineConnect))
}

func TestBouncer_LocalizedStatusUsesUserhostProbe(t *testing.T) {
	_, srv, rec := startBouncerClient(t, func(c *Config) { c.Bouncer = true })
	srv.send(upstreamBurst...)
	rec.waitStates(t, UpstreamConnected)

	// Unrecognised status text while connected → USERHOST probe; the
	// upstream answers, so we stay connected and the 302 isn't forwarded.
	srv.send(zncGermanMisc)
	srv.waitCount("USERHOST tester", 1)
	srv.send(":ergo.test 302 tester :tester=+~u@zqxrzrx52iqc4.irc")
	settle()
	assert.Equal(t, []BouncerUpstream{UpstreamConnected}, rec.snapshot())
	assert.Zero(t, rec.eventKinds(girc.RPL_USERHOST), "probe reply leaked to the renderer")

	// Another one; this time ZNC drops the probe (upstream gone) → timeout.
	srv.send(zncGermanLine)
	srv.waitCount("USERHOST tester", 2)
	rec.waitStates(t, UpstreamConnected, UpstreamDisconnected)
}

func TestBouncer_ProbeCancelledByUpstreamWelcome(t *testing.T) {
	// A probe armed by an unrecognised line must not fire after an upstream
	// 001 — ZNC drops USERHOST right after a (re)connect, which would read
	// as "disconnected".
	c, srv, rec := startBouncerClient(t, func(c *Config) { c.Bouncer = true })
	c.bouncer.mu.Lock()
	c.bouncer.probeDelay = 200 * time.Millisecond
	c.bouncer.mu.Unlock()
	srv.send(upstreamBurst...)
	rec.waitStates(t, UpstreamConnected)
	srv.send(zncGermanMisc)
	srv.send(upstreamBurst...)
	time.Sleep(600 * time.Millisecond)
	assert.Zero(t, srv.countPrefix("USERHOST"))
	assert.Equal(t, []BouncerUpstream{UpstreamConnected}, rec.snapshot())
}

func TestBouncer_PlainServerUnchanged(t *testing.T) {
	// No ZNC signals: no upstream reports, no probes, welcome work once, and
	// a 302 the user asked for is forwarded as usual.
	_, srv, rec := startBouncerClient(t, nil)
	srv.send(":srv 001 tester :Welcome",
		":srv 005 tester NETWORK=Test :are supported by this server",
		":srv 422 tester :MOTD File is missing",
		":NickServ!services@services.test NOTICE tester :This nickname is registered.",
		":srv 302 tester :tester=+~t@host")
	srv.waitCount(lineIdentify, 1)
	srv.waitCount(lineList, 1)
	require.Eventually(t, func() bool { return rec.eventKinds(girc.RPL_USERHOST) == 1 },
		3*time.Second, 5*time.Millisecond)
	settle()
	assert.Empty(t, rec.snapshot())
	assert.Zero(t, srv.countPrefix("USERHOST"))
	assert.Zero(t, srv.countPrefix("PRIVMSG *status"))
	assert.Equal(t, 1, srv.count(lineIdentify))
	assert.Equal(t, 1, srv.count(lineList))
}

// --- bouncerState unit tests (no socket) ---

type fakeBouncerEnv struct {
	mu     sync.Mutex
	sent   []string
	states []BouncerUpstream
	rearms int
	timers []func()
}

func newFakeBouncer(declared, autoConnect bool) (*bouncerState, *fakeBouncerEnv) {
	b := newBouncerState(declared, autoConnect)
	env := &fakeBouncerEnv{}
	b.send = func(l string, _ sendClass) { env.mu.Lock(); env.sent = append(env.sent, l); env.mu.Unlock() }
	// Timers are captured and fired manually by the test.
	b.after = func(_ time.Duration, fn func()) { env.mu.Lock(); env.timers = append(env.timers, fn); env.mu.Unlock() }
	b.selfNick = func() string { return "tester" }
	b.rearm = func() { env.mu.Lock(); env.rearms++; env.mu.Unlock() }
	b.onChange = func(u BouncerUpstream) { env.states = append(env.states, u) }
	return b, env
}

func (e *fakeBouncerEnv) fireTimers() {
	e.mu.Lock()
	ts := e.timers
	e.timers = nil
	e.mu.Unlock()
	for _, fn := range ts {
		fn()
	}
}

func TestBouncerState_ConnectingTimesOut(t *testing.T) {
	b, env := newFakeBouncer(true, false)
	assert.False(t, b.onWelcome(zncServerName))
	b.connect()
	assert.Equal(t, []string{"PRIVMSG *status :connect"}, env.sent)
	// ZNC throttles silently: nothing more arrives.
	env.fireTimers()
	assert.Equal(t, []BouncerUpstream{UpstreamDisconnected, UpstreamConnecting, UpstreamDisconnected}, env.states)
}

func TestBouncerState_ConnectingTimeoutVoidedByWelcome(t *testing.T) {
	b, env := newFakeBouncer(true, false)
	b.onWelcome(zncServerName)
	b.connect()
	assert.True(t, b.onWelcome("ergo.test"))
	env.fireTimers()
	assert.Equal(t, []BouncerUpstream{UpstreamDisconnected, UpstreamConnecting, UpstreamConnected}, env.states)
}

func TestBouncerState_CurrentlyDisconnectedDoesNotCancelConnecting(t *testing.T) {
	b, env := newFakeBouncer(true, false)
	b.onWelcome(zncServerName)
	b.connect()
	b.onStatusMessage("*status", "You are currently disconnected from IRC. Use 'connect' to reconnect.")
	assert.Equal(t, UpstreamConnecting, b.snapshot())
	assert.Equal(t, []BouncerUpstream{UpstreamDisconnected, UpstreamConnecting}, env.states)
}

func TestBouncerState_StatusMessages(t *testing.T) {
	cases := []struct {
		name string
		from BouncerUpstream
		body string
		want BouncerUpstream
		// probe: an unrecognised line arms the USERHOST probe.
		probe bool
	}{
		{"drop while connected", UpstreamConnected, "Disconnected from IRC. Reconnecting...", UpstreamDisconnected, false},
		{"drop with reason", UpstreamConnected, "Disconnected from IRC (Can't resolve server hostname). Reconnecting...", UpstreamDisconnected, false},
		{"explicit disconnect", UpstreamConnected, "Disconnected from IRC. Use 'connect' to reconnect.", UpstreamDisconnected, false},
		{"message lost", UpstreamConnected, "Your message to NickServ got lost, you are not connected to IRC!", UpstreamDisconnected, false},
		{"connected! while down", UpstreamDisconnected, "Connected!", UpstreamConnecting, false},
		{"connected! while up stays up", UpstreamConnected, "Connected!", UpstreamConnected, false},
		{"connecting to while up stays up", UpstreamConnected, "Connecting to ergo2...", UpstreamConnected, false},
		{"localized while connected probes", UpstreamConnected, "Getrennt vom IRC.", UpstreamConnected, true},
		{"localized while connecting probes", UpstreamConnecting, "Verbinde zu ergo...", UpstreamConnecting, true},
		{"localized while disconnected ignored", UpstreamDisconnected, "Verbunden!", UpstreamDisconnected, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			b, env := newFakeBouncer(true, false)
			b.state = tc.from
			b.emitted = tc.from
			b.onStatusMessage("*status", tc.body)
			assert.Equal(t, tc.want, b.snapshot())
			env.fireTimers() // the probe delay, if armed
			if tc.probe {
				assert.Contains(t, env.sent, "USERHOST tester")
			} else {
				assert.NotContains(t, env.sent, "USERHOST tester")
			}
		})
	}
}

func TestServicesState_RearmForUpstream(t *testing.T) {
	s := newServicesState()
	s.setNickservPassword("pw")
	var sent []string
	send := func(target, body string) { sent = append(sent, target+" "+body) }
	noTimers := func(time.Duration, func()) {}

	s.onWelcome(send, noTimers)
	s.onWelcome(send, noTimers) // latched
	assert.Equal(t, 1, countStr(sent, "NickServ IDENTIFY pw"))
	assert.Equal(t, 1, countStr(sent, "NickServ VERSION"))

	// Unclassified: both IDENTIFY and the probe re-arm.
	s.rearmForUpstream()
	s.onWelcome(send, noTimers)
	assert.Equal(t, 2, countStr(sent, "NickServ IDENTIFY pw"))
	assert.Equal(t, 2, countStr(sent, "NickServ VERSION"))

	// Classified: only IDENTIFY re-arms — the verdict outlives the session.
	s.observe("NickServ", "Anope-2.0.10")
	s.rearmForUpstream()
	s.onWelcome(send, noTimers)
	assert.Equal(t, 3, countStr(sent, "NickServ IDENTIFY pw"))
	assert.Equal(t, 2, countStr(sent, "NickServ VERSION"))
}

func countStr(xs []string, x string) int {
	n := 0
	for _, s := range xs {
		if s == x {
			n++
		}
	}
	return n
}

func TestBouncerState_LiveTrafficProvesUpstream(t *testing.T) {
	b := newBouncerState(true, false)
	var got []BouncerUpstream
	b.setOnChange(func(s BouncerUpstream) { got = append(got, s) })
	b.onUpstreamTraffic() // state unknown: no guess
	assert.Empty(t, got)
	b.onWelcome("irc.example.com")
	b.mu.Lock()
	b.enterDisconnectedLocked(&bouncerPost{}) // e.g. a probe that timed out
	b.mu.Unlock()
	b.onUpstreamTraffic()
	assert.Equal(t, []BouncerUpstream{UpstreamConnected, UpstreamDisconnected, UpstreamConnected}, got)
}

func TestIsLiveUpstreamTraffic(t *testing.T) {
	ev := func(raw string) girc.Event { return *girc.ParseEvent(raw) }
	assert.True(t, isLiveUpstreamTraffic(ev(":bob!b@host PRIVMSG #a :hi"), "me"))
	assert.False(t, isLiveUpstreamTraffic(ev(":*status!status@znc.in PRIVMSG me :hi"), "me"), "bouncer module")
	assert.False(t, isLiveUpstreamTraffic(ev(":Me!m@host PRIVMSG #a :hi"), "me"), "our own line (another client)")
	assert.False(t, isLiveUpstreamTraffic(ev("@batch=p :bob!b@host PRIVMSG #a :hi"), "me"), "buffer playback")
	assert.False(t, isLiveUpstreamTraffic(ev(":irc.example.com NOTICE me :hi"), "me"), "server, not a user")
}
