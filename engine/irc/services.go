// Services detection — classifies the package running NickServ / ChanServ /
// etc. on the connected network (Atheme vs Anope vs unknown). Centralised
// in the engine so every client (Electron, future mobile / web) sees the
// same verdict without re-implementing the heuristic.
//
// The detection lifecycle, per Client:
//   1. After 001 RPL_WELCOME, send `VERSION` to NickServ / ChanServ / HostServ.
//      Both Atheme and Anope brand the reply ("atheme-X.Y.Z" / "Anope-X.Y.Z").
//   2. Any NOTICE / PRIVMSG from a service nick is run through the classifier.
//      A hit on either keyword settles the framework as a sticky value.
//   3. If no probe response classifies within a generous window, settle to
//      "unknown" so the UI doesn't sit on "not detected" forever.
//
// Auto-identify (sending `NickServ IDENTIFY <password>`) lives next to this
// because both depend on the post-welcome event and on knowing the
// service-nick conventions.

package irc

import (
	"regexp"
	"strings"
	"sync"
	"time"
)

// ServicesFramework labels the detected package. The empty string means we
// haven't probed yet (or services don't exist on this network).
type ServicesFramework string

const (
	FrameworkAtheme  ServicesFramework = "atheme"
	FrameworkAnope   ServicesFramework = "anope"
	// Ergo IRCd (formerly Oragono) ships built-in account management
	// under the same NickServ name. It's modern, runs ~15% of new
	// networks, and has its own command set that doesn't line up with
	// Atheme or Anope. We track it as a first-class framework so the
	// UI can show appropriate flows (e.g. Ergo's SACERT is its
	// preferred login mechanism, not REGISTER+IDENTIFY).
	FrameworkErgo    ServicesFramework = "ergo"
	// Anything else — Bahamut services, UnderNet X/W, ratbox-services,
	// custom in-house packages — bucket here. The user can still drive
	// services via raw /msg commands; the UI just doesn't render a
	// framework-specific command panel.
	FrameworkUnknown ServicesFramework = "unknown"

	// How long to wait after firing VERSION probes before settling to
	// "unknown" if nothing definitive arrived. Most replies land in
	// <1s; 6s tolerates rate-limited services without leaving the UI
	// hung on the pre-classification state.
	servicesProbeTimeout = 6 * time.Second

	// VERSION is the cheap fast-path probe (one line back, brands the
	// banner on services that support it). Some deployments — most
	// notably UnrealIRCd+Anope as configured on irc.boson.chat — reject
	// VERSION as "Unknown command". After this short delay we send the
	// noisier HELP fallback, which is universally supported and gives
	// us a verb-listing body to classify against. Skipped when we've
	// already classified from a VERSION reply, so well-branded networks
	// pay no extra noise cost.
	servicesHelpFallbackDelay = 2 * time.Second
)

// Well-known IRC service nicks — same list the renderer used to keep,
// now the engine's responsibility since detection lives here.
var serviceNicks = map[string]bool{
	"nickserv":   true,
	"chanserv":   true,
	"operserv":   true,
	"memoserv":   true,
	"botserv":    true,
	"hostserv":   true,
	"saslserv":   true,
	"authserv":   true,
	"aliasserv":  true,
	"groupserv":  true,
	"rootserv":   true,
	"gameserv":   true,
	"statserv":   true,
	"helpserv":   true,
	"global":     true,
}

// IsServiceSender mirrors the renderer-side helper of the same name —
// recognises well-known service nicks plus server-hostname senders.
func IsServiceSender(from string) bool {
	if from == "" {
		return true
	}
	if serviceNicks[strings.ToLower(from)] {
		return true
	}
	// Servers send NOTICEs from `hub.example.org`; nicks can't contain `.`.
	if strings.ContainsRune(from, '.') {
		return true
	}
	return false
}

// Word-boundary matchers. Two tiers:
//
//   Brand match — the package literally names itself in a banner.
//   Trivial wins when it shows up (Atheme + Anope both brand their
//   VERSION banner with their name); useless when the network has
//   rebranded or the package's VERSION command is gagged.
//
//   Verb match — the package's HELP listing uses package-specific
//   command verbs. This is the dominant signal in the wild: many
//   networks (especially UnrealIRCd+Anope deployments seen in the
//   wild) strip the brand from banners but keep the standard verb
//   set. The verbs below are unique to one package within Atheme
//   vs Anope, taken from each project's HELP output:
//     - CONFIRM: Anope's post-REGISTER passcode flow. Atheme uses
//       a different "VERIFY REGISTER" form, no CONFIRM verb.
//     - TAXONOMY / UNGROUP / FLAGS: Atheme-specific verbs. FLAGS is
//       Atheme's primary channel-access UI; Anope uses ACCESS.
//       TAXONOMY is Atheme's per-account metadata browser.
//       UNGROUP detaches an alias nick (the inverse of GROUP);
//       Anope doesn't expose UNGROUP.
//
// Case-insensitive word-boundary match against these verbs lets us
// classify off any HELP reply even when no brand text is present.
var (
	rxAtheme = regexp.MustCompile(`(?i)\batheme\b`)
	rxAnope  = regexp.MustCompile(`(?i)\banope\b`)
	// Ergo names itself in its NickServ + ChanServ banners
	// ("Ergo IRCd version X.Y.Z"). The brand keyword also shows up
	// in the server's own VERSION reply / 002-004 lines (RPL_YOURHOST
	// / RPL_CREATED). Same word-boundary safety.
	rxErgo   = regexp.MustCompile(`(?i)\bergo\b`)

	rxAnopeVerb  = regexp.MustCompile(`(?i)\bconfirm\b`)
	rxAthemeVerb = regexp.MustCompile(`(?i)\b(?:taxonomy|ungroup|flags)\b`)
)

// DetectServicesFramework classifies a single service NOTICE/PRIVMSG body
// into a framework. Returns empty string when no signature matches.
//
// Brand matches win first (cheap + unambiguous when present). Verb
// matches are the fallback for networks whose deployments don't brand
// their banners — most production IRCs in the wild fall here.
func DetectServicesFramework(body string) ServicesFramework {
	if body == "" {
		return ""
	}
	// Brand-name matches are unambiguous; check first.
	if rxAtheme.MatchString(body) {
		return FrameworkAtheme
	}
	if rxAnope.MatchString(body) {
		return FrameworkAnope
	}
	if rxErgo.MatchString(body) {
		return FrameworkErgo
	}
	// Verb-fingerprint matches handle the un-branded deployments.
	// Ergo isn't covered here — its verb set overlaps with Atheme/Anope
	// enough that verb-based detection would false-positive. Its brand
	// keyword is reliable when the deployment hasn't been rebranded.
	if rxAthemeVerb.MatchString(body) {
		return FrameworkAtheme
	}
	if rxAnopeVerb.MatchString(body) {
		return FrameworkAnope
	}
	return ""
}

// servicesState is the per-Client detection state. The Client embeds one
// of these and uses the methods below as event hooks. The struct is
// internal — the only externally-visible surface is `Client.Services()`
// returning the current verdict and `Client.NickservIdentify(pw)`.
type servicesState struct {
	mu sync.Mutex

	// Current verdict — empty string until classified.
	framework ServicesFramework

	// Latched flags so a 001 re-emit (rare but observed on nick-collision
	// recoveries) doesn't repeat the probe or the auto-identify.
	probeFired         bool
	autoIdentifyFired  bool
	// Stopped via stop() when the IRC client is shutting down; prevents
	// the timeout fallback from racing a fresh probe on reconnect.
	stopCh chan struct{}

	// Optional auto-identify password, set at connect time. When set, the
	// `001` handler sends `PRIVMSG NickServ IDENTIFY <password>` before
	// the VERSION probes. Empty means no auto-identify.
	nickservPassword string

	// Fired when the framework verdict transitions from empty → set or
	// from any value → another. Wired in the IPC layer to forward up to
	// the renderer; tests can plug a recording function in.
	onChange func(ServicesFramework)
}

func newServicesState() *servicesState {
	return &servicesState{
		stopCh: make(chan struct{}),
	}
}

// setOnChange installs the verdict-change callback. Called from the
// Client constructor before any IRC activity.
func (s *servicesState) setOnChange(fn func(ServicesFramework)) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.onChange = fn
}

// setNickservPassword stashes a password to be sent automatically after
// RPL_WELCOME. Set at connect time via Config.NickservPassword; an empty
// string disables auto-identify.
func (s *servicesState) setNickservPassword(pw string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.nickservPassword = pw
}

// framework returns the current verdict — empty string when unclassified.
func (s *servicesState) snapshot() ServicesFramework {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.framework
}

// classify is called for every NOTICE / PRIVMSG body from a service.
// Returns true if the verdict changed and the caller should fire the
// onChange callback.
func (s *servicesState) observe(from, body string) {
	if !IsServiceSender(from) {
		return
	}
	got := DetectServicesFramework(body)
	if got == "" {
		return
	}
	s.mu.Lock()
	if s.framework == got {
		s.mu.Unlock()
		return
	}
	// Sticky upgrade — once we've matched atheme/anope, later messages
	// don't downgrade us to "unknown".
	if (s.framework == FrameworkAtheme || s.framework == FrameworkAnope) && got == FrameworkUnknown {
		s.mu.Unlock()
		return
	}
	s.framework = got
	cb := s.onChange
	s.mu.Unlock()
	if cb != nil {
		cb(got)
	}
}

// onWelcome is called by the Client when it receives 001 RPL_WELCOME.
// Fires the auto-identify (if a password is configured) and the VERSION
// probes across NickServ + ChanServ + HostServ. Re-emits of 001 are
// guarded by `probeFired` / `autoIdentifyFired`.
//
// `send` is a callback the Client provides for shipping a PRIVMSG (we
// don't import the girc.Client here to keep this package testable in
// isolation). `scheduleAfter` is similarly injected so tests can drive
// the timeout without real time.
func (s *servicesState) onWelcome(
	send func(target, message string),
	scheduleAfter func(d time.Duration, fn func()),
) {
	s.mu.Lock()
	password := s.nickservPassword
	shouldIdentify := !s.autoIdentifyFired && password != ""
	shouldProbe := !s.probeFired
	s.autoIdentifyFired = true
	s.probeFired = true
	s.mu.Unlock()

	if shouldIdentify {
		send("NickServ", "IDENTIFY "+password)
	}
	if shouldProbe {
		// Probe several services with VERSION first — the fast path
		// for branded deployments. The first to land a hit settles
		// the verdict.
		send("NickServ", "VERSION")
		send("ChanServ", "VERSION")
		send("HostServ", "VERSION")
		// HELP fallback for deployments that reject VERSION. We send
		// `HELP` at +2s if nothing has classified yet — gives the
		// passive observer the rich verb-listing body it needs to
		// classify by command fingerprint (CONFIRM = Anope, TAXONOMY
		// /UNGROUP/FLAGS = Atheme). Two services is enough; HELP
		// banners are bulky and we want to keep the server log tidy.
		scheduleAfter(servicesHelpFallbackDelay, func() {
			s.mu.Lock()
			classified := s.framework != ""
			s.mu.Unlock()
			if classified {
				return
			}
			send("NickServ", "HELP")
			send("ChanServ", "HELP")
		})
		// Settle to "unknown" if nothing classified within the window.
		scheduleAfter(servicesProbeTimeout, func() {
			s.mu.Lock()
			if s.framework != "" {
				s.mu.Unlock()
				return
			}
			s.framework = FrameworkUnknown
			cb := s.onChange
			s.mu.Unlock()
			if cb != nil {
				cb(FrameworkUnknown)
			}
		})
	}
}

// stop releases the state. Safe to call multiple times.
func (s *servicesState) stop() {
	s.mu.Lock()
	defer s.mu.Unlock()
	select {
	case <-s.stopCh:
		return
	default:
		close(s.stopCh)
	}
}
