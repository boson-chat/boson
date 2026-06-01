//go:build e2e

// Atheme e2e: drives REGISTER → IDENTIFY → INFO → DROP against a live
// Atheme+InspIRCd stack and writes the captured NickServ chatter to
// fixtures/atheme/<scenario>.json for the renderer's classifier tests.
//
// Run via:
//
//	make test-e2e-services-atheme
//
// which starts the `e2e-atheme` docker profile (InspIRCd 3 + Atheme
// 7.2.12, see infra/atheme/) and invokes this package with the e2e
// build tag.
//
// Our infra runs Atheme with `serverinfo::auth = none;` so REGISTER
// completes in a single round-trip — Atheme replies with
// "<name> has now been verified." instead of starting an SMTP
// confirmation flow. The atheme/identify success reply is "You are
// now identified for <name>." (canonical Atheme phrasing).
package atheme_test

import (
	"fmt"
	"os"
	"strings"
	"testing"
	"time"

	e2e "github.com/boson-chat/boson/engine/internal/services_e2e"
	"github.com/boson-chat/boson/engine/irc"
)

const ircdLabel = "inspircd-3.18 + atheme-7.2.12"

func ircAddr() (string, int) {
	host := os.Getenv("E2E_ATHEME_HOST")
	if host == "" {
		host = "127.0.0.1"
	}
	port := 6669
	if v := os.Getenv("E2E_ATHEME_PORT"); v != "" {
		fmt.Sscanf(v, "%d", &port)
	}
	return host, port
}

func uniqueNick(prefix string) string {
	return fmt.Sprintf("%s%d", prefix, time.Now().UnixNano()%1_000_000_000)
}

// ---------------------------------------------------------------------
// Scenario: register-no-confirm — Atheme with `auth = none`
// completes REGISTER in one round-trip.
// ---------------------------------------------------------------------
func TestAtheme_RegisterNoConfirm(t *testing.T) {
	host, port := ircAddr()
	nick := uniqueNick("e2ereg")
	password := "hunter2-" + uniqueNick("p")
	email := "nobody@test.invalid"

	client, rec, teardown := e2e.ConnectAndWait(t, irc.Config{
		Hostname: host, Port: port, TLS: false,
		Nick: nick, User: nick, RealName: nick,
	})
	defer teardown()

	e2e.NickservMsg(t, client, fmt.Sprintf("REGISTER %s %s", password, email))

	// Atheme with auth=none replies "<nick> is now registered to <name>."
	// + "You are now identified for <nick>." in quick succession.
	got, ok := rec.WaitForMatch(5*time.Second, func(e e2e.CapturedEvent) bool {
		body := strings.ToLower(e.Message)
		return strings.Contains(body, "is now registered") ||
			strings.Contains(body, "now identified for") ||
			strings.Contains(body, "has now been verified")
	})
	if !ok {
		t.Fatalf("never observed registration-confirmed reply; snapshot=%+v", rec.Snapshot())
	}
	t.Logf("captured register reply: kind=%s msg=%q", got.Kind, got.Message)

	e2e.WriteFixture(t, "atheme", "register-no-confirm", ircdLabel, rec.Snapshot())
}

// ---------------------------------------------------------------------
// Scenario: identify-success.
// ---------------------------------------------------------------------
func TestAtheme_IdentifySuccess(t *testing.T) {
	host, port := ircAddr()
	nick := uniqueNick("e2eidok")
	password := "hunter2-" + uniqueNick("p")
	email := "nobody@test.invalid"

	{
		client, _, teardown := e2e.ConnectAndWait(t, irc.Config{
			Hostname: host, Port: port, TLS: false,
			Nick: nick, User: nick, RealName: nick,
		})
		e2e.NickservMsg(t, client, fmt.Sprintf("REGISTER %s %s", password, email))
		time.Sleep(500 * time.Millisecond)
		teardown()
	}

	client, rec, teardown := e2e.ConnectAndWait(t, irc.Config{
		Hostname: host, Port: port, TLS: false,
		Nick: nick, User: nick, RealName: nick,
	})
	defer teardown()

	e2e.NickservMsg(t, client, "IDENTIFY "+password)

	got, ok := rec.WaitForMatch(5*time.Second, func(e e2e.CapturedEvent) bool {
		body := strings.ToLower(e.Message)
		return strings.Contains(body, "you are now identified") ||
			strings.Contains(body, "you are now logged in") ||
			strings.Contains(body, "password accepted")
	})
	if !ok {
		t.Fatalf("never observed identify-success reply; snapshot=%+v", rec.Snapshot())
	}
	t.Logf("captured identify reply: kind=%s msg=%q", got.Kind, got.Message)

	e2e.WriteFixture(t, "atheme", "identify-success", ircdLabel, rec.Snapshot())
}

// ---------------------------------------------------------------------
// Scenario: identify-wrong-password.
// ---------------------------------------------------------------------
func TestAtheme_IdentifyWrongPassword(t *testing.T) {
	host, port := ircAddr()
	nick := uniqueNick("e2eidko")
	password := "hunter2-" + uniqueNick("p")
	email := "nobody@test.invalid"

	{
		client, _, teardown := e2e.ConnectAndWait(t, irc.Config{
			Hostname: host, Port: port, TLS: false,
			Nick: nick, User: nick, RealName: nick,
		})
		e2e.NickservMsg(t, client, fmt.Sprintf("REGISTER %s %s", password, email))
		time.Sleep(500 * time.Millisecond)
		teardown()
	}

	client, rec, teardown := e2e.ConnectAndWait(t, irc.Config{
		Hostname: host, Port: port, TLS: false,
		Nick: nick, User: nick, RealName: nick,
	})
	defer teardown()

	e2e.NickservMsg(t, client, "IDENTIFY wrong-password-xyzzy")

	got, ok := rec.WaitForMatch(5*time.Second, func(e e2e.CapturedEvent) bool {
		body := strings.ToLower(e.Message)
		return strings.Contains(body, "invalid password") ||
			strings.Contains(body, "password incorrect") ||
			strings.Contains(body, "authentication failed")
	})
	if !ok {
		t.Fatalf("never observed identify-failed reply; snapshot=%+v", rec.Snapshot())
	}
	t.Logf("captured wrong-password reply: %q", got.Message)

	e2e.WriteFixture(t, "atheme", "identify-wrong-password", ircdLabel, rec.Snapshot())
}

// ---------------------------------------------------------------------
// Scenario: info — INFO on a registered nick. Atheme's INFO reply is
// multi-line including a registration-date line ("Registered: ...").
// ---------------------------------------------------------------------
func TestAtheme_Info(t *testing.T) {
	host, port := ircAddr()
	nick := uniqueNick("e2einfo")
	password := "hunter2-" + uniqueNick("p")
	email := "nobody@test.invalid"

	client, rec, teardown := e2e.ConnectAndWait(t, irc.Config{
		Hostname: host, Port: port, TLS: false,
		Nick: nick, User: nick, RealName: nick,
	})
	defer teardown()

	e2e.NickservMsg(t, client, fmt.Sprintf("REGISTER %s %s", password, email))
	time.Sleep(500 * time.Millisecond)
	e2e.NickservMsg(t, client, "INFO "+nick)

	got, ok := rec.WaitForMatch(5*time.Second, func(e e2e.CapturedEvent) bool {
		body := strings.ToLower(e.Message)
		return strings.Contains(body, "registered") ||
			strings.Contains(body, "information on") ||
			strings.Contains(body, "is ")
	})
	if !ok {
		t.Fatalf("never observed INFO reply; snapshot=%+v", rec.Snapshot())
	}
	t.Logf("captured INFO reply: %q", got.Message)

	e2e.WriteFixture(t, "atheme", "info", ircdLabel, rec.Snapshot())
}

// ---------------------------------------------------------------------
// Scenario: drop-confirm-prompt — Atheme's `DROP <account>
// <password>` returns a two-step confirmation: "Please confirm by
// replying with /msg NickServ DROP <account> <password> <token>".
// The token is a session-bound key with a short TTL; the second-step
// follow-through has timing nuances (matching Ergo's UNREGISTER
// pattern) that warrant a dedicated scenario. Capturing the prompt
// here is enough for the classifier to verify it lands as
// drop-confirm-prompt.
// ---------------------------------------------------------------------
func TestAtheme_DropConfirmPrompt(t *testing.T) {
	host, port := ircAddr()
	nick := uniqueNick("e2edrop")
	password := "hunter2-" + uniqueNick("p")
	email := "nobody@test.invalid"

	client, rec, teardown := e2e.ConnectAndWait(t, irc.Config{
		Hostname: host, Port: port, TLS: false,
		Nick: nick, User: nick, RealName: nick,
	})
	defer teardown()

	e2e.NickservMsg(t, client, fmt.Sprintf("REGISTER %s %s", password, email))
	time.Sleep(800 * time.Millisecond)
	e2e.NickservMsg(t, client, fmt.Sprintf("DROP %s %s", nick, password))

	got, ok := rec.WaitForMatch(5*time.Second, func(e e2e.CapturedEvent) bool {
		return strings.Contains(strings.ToLower(e.Message), "please confirm by replying")
	})
	if !ok {
		t.Fatalf("never observed drop confirm-prompt; snapshot=%+v", rec.Snapshot())
	}
	t.Logf("captured drop confirm-prompt: %q", got.Message)

	e2e.WriteFixture(t, "atheme", "drop-confirm-prompt", ircdLabel, rec.Snapshot())
}

// ---------------------------------------------------------------------
// Scenario: full-drop-roundtrip — drives the COMPLETE two-step DROP:
// REGISTER → DROP <acct> <pw> → parse the confirm prompt to extract
// the verbatim follow-up command → replay it → capture EVERYTHING
// that comes back, including any post-success notices that might
// re-trigger the classifier in unexpected ways. Live evidence for
// the post-drop loop the user reported on irc.libera.chat:
// what does Atheme say after a successful drop, and does anything
// in those bodies trip the service-confirm-replay regex into
// re-firing /msg NickServ commands?
// ---------------------------------------------------------------------
func TestAtheme_DropFullRoundtrip(t *testing.T) {
	host, port := ircAddr()
	nick := uniqueNick("e2efull")
	password := "hunter2-" + uniqueNick("p")
	email := "nobody@test.invalid"

	client, rec, teardown := e2e.ConnectAndWait(t, irc.Config{
		Hostname: host, Port: port, TLS: false,
		Nick: nick, User: nick, RealName: nick,
	})
	defer teardown()

	e2e.NickservMsg(t, client, fmt.Sprintf("REGISTER %s %s", password, email))
	time.Sleep(800 * time.Millisecond)
	e2e.NickservMsg(t, client, fmt.Sprintf("DROP %s %s", nick, password))

	// Wait for the confirm-prompt. Parse out the verbatim follow-up.
	prompt, ok := rec.WaitForMatch(5*time.Second, func(e e2e.CapturedEvent) bool {
		body := strings.ToLower(e.Message)
		return strings.Contains(body, "/msg nickserv drop") &&
			(strings.Contains(body, "reply") || strings.Contains(body, "confirm"))
	})
	if !ok {
		t.Fatalf("never observed drop confirm-prompt; snapshot=%+v", rec.Snapshot())
	}
	t.Logf("STEP 1 prompt body: %q", prompt.Message)

	// Extract the literal `DROP <acct> ... ` portion the server wants
	// us to echo back. Mirrors the renderer's service-confirm-replay
	// extractor in chat.service.ts.
	stripped := stripFormat(prompt.Message)
	idx := strings.Index(strings.ToLower(stripped), "/msg nickserv ")
	if idx < 0 {
		t.Fatalf("prompt has no /msg NickServ inline command: %q", prompt.Message)
	}
	tail := stripped[idx+len("/msg nickserv "):]
	// Trim trailing punctuation / whitespace.
	tail = strings.TrimRight(strings.TrimSpace(tail), ".​")
	t.Logf("STEP 2 replaying verbatim: %q", tail)

	// Reset the recorder's high-water mark so subsequent waits look
	// only at events AFTER the replay.
	preReplay := len(rec.Snapshot())
	e2e.NickservMsg(t, client, tail)

	// Wait for either drop-success phrasing OR a 6-second tail
	// window — we want to record EVERYTHING that comes back so we
	// can audit it for replay-regex false-positives.
	time.Sleep(3 * time.Second)
	post := rec.Snapshot()[preReplay:]
	t.Logf("STEP 3 captured %d events after replay:", len(post))
	for i, e := range post {
		t.Logf("  [%d] %s from %s: %q", i, e.Kind, e.From, e.Message)
	}

	e2e.WriteFixture(t, "atheme", "drop-full-roundtrip", ircdLabel, rec.Snapshot())
}

// stripFormat removes IRC formatting bytes so we can match phrasings
// without worrying about bold/italic wrappers. Mirrors the renderer's
// service-confirm-replay handler.
func stripFormat(s string) string {
	out := strings.Builder{}
	for _, r := range s {
		switch r {
		case 0x02, 0x0f, 0x11, 0x16, 0x1d, 0x1e, 0x1f:
			continue
		}
		out.WriteRune(r)
	}
	return out.String()
}
