package irc

import (
	"sync"
	"testing"
	"time"
)

func TestDetectServicesFramework(t *testing.T) {
	cases := []struct {
		name string
		body string
		want ServicesFramework
	}{
		// Brand-name matches.
		{"atheme version reply", "atheme-7.2.12. Compiled May 12 2024", FrameworkAtheme},
		{"atheme banner mention", "Powered by Atheme IRC Services", FrameworkAtheme},
		{"anope version reply", "Anope-2.0.10", FrameworkAnope},
		{"anope banner mention", "Anope IRC Services version 2.0", FrameworkAnope},
		{"case insensitive — atheme", "ATHEME version 7", FrameworkAtheme},
		{"case insensitive — anope", "anope ircd services", FrameworkAnope},
		// Verb-fingerprint matches (the common case in deployments that
		// strip brand names from their banners — observed live on
		// irc.boson.chat which runs UnrealIRCd + Anope without brand).
		{"anope verb — CONFIRM in HELP listing", "    CONFIRM        Confirm a passcode", FrameworkAnope},
		{"anope verb — Confirm in narrative", "Use /msg NickServ confirm <code> to verify", FrameworkAnope},
		{"anope verb — RESEND in HELP listing", "    RESEND         Resend a confirmation email", FrameworkAnope},
		{"anope verb — GLIST in HELP listing", "    GLIST          List grouped nicknames", FrameworkAnope},
		// Verbs observed live on irc.boson.chat's ChanServ HELP.
		{"anope verb — ENFORCE in ChanServ HELP", "AKICK, CLONE, ENFORCE, ENTRYMSG, LOG, MODE", FrameworkAnope},
		{"anope verb — CLONE alone", "Use CLONE to copy channel settings", FrameworkAnope},
		{"atheme verb — TAXONOMY in HELP", "    TAXONOMY       Display per-account metadata", FrameworkAtheme},
		{"atheme verb — UNGROUP in HELP", "    UNGROUP        Detach a grouped nick", FrameworkAtheme},
		// Regression: Anope's ChanServ HELP lists FLAGS (cs_flags.cpp).
		// FLAGS alone must NOT classify as Atheme — otherwise the wrong
		// adapter fires DROP with 2 args, leaking the password into the
		// nick slot. Caught live on irc.boson.chat.
		{"anope ChanServ HELP with FLAGS — must NOT be Atheme", "    FLAGS          Manipulate channel access flags", ServicesFramework("")},
		// And the same body alongside a CONFIRM mention (real Anope HELP
		// listings are multi-line) must classify Anope, not Atheme.
		{"anope ChanServ HELP listing both FLAGS and CONFIRM", "    FLAGS          Manipulate channel access flags\n    CONFIRM        Confirm a passcode", FrameworkAnope},
		// Ergo IRCd's built-in services brand themselves in HELP /
		// server VERSION but verb-set overlaps with Atheme/Anope, so
		// only brand match is used.
		{"ergo banner", "Ergo IRCd 2.13.0 — built-in services", FrameworkErgo},
		{"ergo lowercase", "running ergo 2.12.0", FrameworkErgo},
		// No match.
		{"no match — plain welcome", "Welcome to the network!", ServicesFramework("")},
		{"no match — generic notice", "This nickname is registered.", ServicesFramework("")},
		{"no match — common error", "Unknown command FOO.", ServicesFramework("")},
		{"word boundary — panopent != anope", "panopent and friends", ServicesFramework("")},
		{"word boundary — athemeoid != atheme", "athemeoid behaviour", ServicesFramework("")},
		{"empty body", "", ServicesFramework("")},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := DetectServicesFramework(tc.body); got != tc.want {
				t.Fatalf("got %q, want %q", got, tc.want)
			}
		})
	}
}

func TestIsServiceSender(t *testing.T) {
	for _, nick := range []string{"NickServ", "nickserv", "ChanServ", "MemoServ", "OperServ", "global"} {
		if !IsServiceSender(nick) {
			t.Errorf("%q should be a service sender", nick)
		}
	}
	if !IsServiceSender("hub.example.org") {
		t.Errorf("server hostname should be a service sender")
	}
	if IsServiceSender("alice") {
		t.Errorf("plain nick should NOT be a service sender")
	}
	if !IsServiceSender("") {
		t.Errorf("empty sender (anonymous notice) should be a service sender")
	}
}

func TestServicesState_ObserveClassifiesAndSticky(t *testing.T) {
	s := newServicesState()
	var verdicts []ServicesFramework
	var mu sync.Mutex
	s.setOnChange(func(fw ServicesFramework) {
		mu.Lock()
		defer mu.Unlock()
		verdicts = append(verdicts, fw)
	})

	// Non-service sender → no verdict.
	s.observe("alice", "atheme-7")
	if s.snapshot() != "" {
		t.Fatalf("non-service sender should not change framework, got %q", s.snapshot())
	}

	// Atheme keyword in a NickServ notice → set.
	s.observe("NickServ", "Powered by Atheme")
	if s.snapshot() != FrameworkAtheme {
		t.Fatalf("expected atheme, got %q", s.snapshot())
	}

	// Sticky: a later "unknown" body doesn't downgrade us.
	s.observe("NickServ", "Please identify.")
	if s.snapshot() != FrameworkAtheme {
		t.Fatalf("expected sticky atheme, got %q", s.snapshot())
	}

	mu.Lock()
	defer mu.Unlock()
	if len(verdicts) != 1 || verdicts[0] != FrameworkAtheme {
		t.Fatalf("expected exactly one verdict (atheme), got %v", verdicts)
	}
}

func TestServicesState_OnWelcomeFiresProbesAndIdentify(t *testing.T) {
	s := newServicesState()
	s.setNickservPassword("hunter2")

	type sent struct {
		target string
		body   string
	}
	var sends []sent
	var scheduled []time.Duration

	s.onWelcome(
		func(target, body string) {
			sends = append(sends, sent{target, body})
		},
		func(d time.Duration, fn func()) {
			scheduled = append(scheduled, d)
			// Don't fire — test inspects scheduling, not the callback.
			_ = fn
		},
	)

	want := []sent{
		{"NickServ", "IDENTIFY hunter2"},
		{"NickServ", "VERSION"},
		{"ChanServ", "VERSION"},
		{"HostServ", "VERSION"},
	}
	if len(sends) != len(want) {
		t.Fatalf("expected %d sends, got %d: %+v", len(want), len(sends), sends)
	}
	for i, s := range sends {
		if s != want[i] {
			t.Errorf("send[%d]: got %+v, want %+v", i, s, want[i])
		}
	}
	// Two timers: the HELP fallback (~2s) and the "settle to unknown"
	// (~6s) overall timeout. Both fire only if classification is still
	// unresolved when their delays elapse.
	if len(scheduled) != 2 {
		t.Fatalf("expected two scheduled timers (HELP fallback + unknown settle), got %d", len(scheduled))
	}
	if scheduled[0] != servicesHelpFallbackDelay {
		t.Errorf("first scheduled delay: got %v, want %v", scheduled[0], servicesHelpFallbackDelay)
	}
	if scheduled[1] != servicesProbeTimeout {
		t.Errorf("second scheduled delay: got %v, want %v", scheduled[1], servicesProbeTimeout)
	}
}

// Verify the HELP fallback fires after the delay when nothing has
// classified yet — and skips when a verdict has already landed.
func TestServicesState_HelpFallbackFires(t *testing.T) {
	s := newServicesState()
	var helpSends []string
	var versionSends []string
	var pendingFns []func()
	s.onWelcome(
		func(target, body string) {
			if body == "HELP" {
				helpSends = append(helpSends, target)
			} else {
				versionSends = append(versionSends, target)
			}
		},
		func(d time.Duration, fn func()) {
			pendingFns = append(pendingFns, fn)
		},
	)
	// Initial VERSION probes only.
	if got, want := len(versionSends), 3; got != want {
		t.Fatalf("VERSION probes: got %d, want %d", got, want)
	}
	if len(helpSends) != 0 {
		t.Fatalf("HELP fired before fallback timer: %v", helpSends)
	}
	// Fire the HELP-fallback timer. Verdict is still empty → HELP fires.
	pendingFns[0]()
	if got, want := helpSends, []string{"NickServ", "ChanServ"}; !equalSlice(got, want) {
		t.Errorf("HELP probes after fallback: got %v, want %v", got, want)
	}
}

func TestServicesState_HelpFallbackSkippedIfAlreadyClassified(t *testing.T) {
	s := newServicesState()
	var helpSends []string
	var pendingFns []func()
	s.onWelcome(
		func(target, body string) {
			if body == "HELP" {
				helpSends = append(helpSends, target)
			}
		},
		func(d time.Duration, fn func()) { pendingFns = append(pendingFns, fn) },
	)
	// VERSION reply lands and classifies us.
	s.observe("NickServ", "atheme-7.2.12")
	// Now the HELP-fallback timer fires — should be a no-op.
	pendingFns[0]()
	if len(helpSends) != 0 {
		t.Errorf("HELP should not fire when already classified, got %v", helpSends)
	}
}

func equalSlice(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

func TestServicesState_OnWelcomeWithoutPasswordSkipsIdentify(t *testing.T) {
	s := newServicesState()
	// No password set.
	var sends []string
	s.onWelcome(
		func(target, body string) { sends = append(sends, target+" "+body) },
		func(d time.Duration, fn func()) {},
	)
	for _, line := range sends {
		if line == "NickServ IDENTIFY " {
			t.Fatalf("auto-identify fired with empty password")
		}
		if len(line) >= len("NickServ IDENTIFY ") && line[:len("NickServ IDENTIFY ")] == "NickServ IDENTIFY " {
			t.Fatalf("auto-identify fired despite no stored password: %q", line)
		}
	}
	want := []string{"NickServ VERSION", "ChanServ VERSION", "HostServ VERSION"}
	if len(sends) != len(want) {
		t.Fatalf("expected %d probe sends, got %d: %v", len(want), len(sends), sends)
	}
	for i, s := range sends {
		if s != want[i] {
			t.Errorf("send[%d]: got %q, want %q", i, s, want[i])
		}
	}
}

func TestServicesState_OnWelcomeLatchesAgainstReEmit(t *testing.T) {
	s := newServicesState()
	s.setNickservPassword("pw")
	var count int
	send := func(target, body string) { count++ }
	sched := func(d time.Duration, fn func()) {}

	s.onWelcome(send, sched)
	first := count
	s.onWelcome(send, sched)
	if count != first {
		t.Fatalf("second onWelcome re-fired sends: count went %d → %d", first, count)
	}
}

func TestServicesState_TimeoutFallbackSettlesUnknown(t *testing.T) {
	s := newServicesState()
	var verdict ServicesFramework
	s.setOnChange(func(fw ServicesFramework) { verdict = fw })

	// Capture the scheduled fn so we can fire it manually.
	var scheduledFn func()
	s.onWelcome(
		func(target, body string) {},
		func(d time.Duration, fn func()) { scheduledFn = fn },
	)
	if scheduledFn == nil {
		t.Fatalf("no fallback scheduled")
	}
	// Simulate the window elapsing.
	scheduledFn()
	if s.snapshot() != FrameworkUnknown {
		t.Fatalf("expected unknown after timeout, got %q", s.snapshot())
	}
	if verdict != FrameworkUnknown {
		t.Fatalf("expected onChange(unknown), got %q", verdict)
	}
}

func TestServicesState_TimeoutFallbackSkipsIfAlreadyClassified(t *testing.T) {
	s := newServicesState()
	var verdicts []ServicesFramework
	s.setOnChange(func(fw ServicesFramework) { verdicts = append(verdicts, fw) })

	var scheduledFn func()
	s.onWelcome(
		func(target, body string) {},
		func(d time.Duration, fn func()) { scheduledFn = fn },
	)

	// A probe reply lands first.
	s.observe("NickServ", "atheme-7")

	// Now the timeout fires — should NOT overwrite the atheme verdict.
	scheduledFn()
	if s.snapshot() != FrameworkAtheme {
		t.Fatalf("expected sticky atheme, got %q", s.snapshot())
	}
	if len(verdicts) != 1 || verdicts[0] != FrameworkAtheme {
		t.Fatalf("expected one verdict (atheme), got %v", verdicts)
	}
}
