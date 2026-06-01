//go:build e2e

// Anope e2e: drives REGISTER → IDENTIFY → INFO → DROP against a live
// Anope+UnrealIRCd stack and writes the captured NickServ chatter to
// fixtures/anope/<scenario>.json for the renderer's classifier tests.
//
// Run via:
//
//	make test-e2e-services-anope
//
// which starts the `e2e-anope` docker profile (Unreal + Anope, see
// infra/anope/) and invokes this package with the e2e build tag.
//
// Our infra runs Anope with `registration = "none"` in nickserv.conf
// so REGISTER completes in a single round-trip (no email step). The
// email-confirm flow needs a separate stack with an SMTP-capture
// sidecar — out of scope here.
package anope_test

import (
	"fmt"
	"os"
	"strings"
	"testing"
	"time"

	e2e "github.com/boson-chat/boson/engine/internal/services_e2e"
	"github.com/boson-chat/boson/engine/irc"
)

const ircdLabel = "unrealircd-5.0.7 + anope-2.0.19"

func ircAddr() (string, int) {
	host := os.Getenv("E2E_ANOPE_HOST")
	if host == "" {
		host = "127.0.0.1"
	}
	port := 6668
	if v := os.Getenv("E2E_ANOPE_PORT"); v != "" {
		fmt.Sscanf(v, "%d", &port)
	}
	return host, port
}

func uniqueNick(prefix string) string {
	return fmt.Sprintf("%s%d", prefix, time.Now().UnixNano()%1_000_000_000)
}

// ---------------------------------------------------------------------
// Scenario: register-no-confirm — Anope is configured here with
// `registration = "none"` so REGISTER lands directly on success.
// ---------------------------------------------------------------------
func TestAnope_RegisterNoConfirm(t *testing.T) {
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

	// Anope's actual phrasing observed live: `Nickname X registered.`
	// — terse, no "has been". The 900 RPL_LOGGEDIN also fires
	// immediately on the no-confirm path, which is an even stronger
	// signal that we're identified post-register.
	got, ok := rec.WaitForMatch(5*time.Second, func(e e2e.CapturedEvent) bool {
		body := strings.ToLower(e.Message)
		return strings.Contains(body, "registered") ||
			strings.Contains(body, "account is now confirmed") ||
			e.Kind == "900"
	})
	if !ok {
		t.Fatalf("never observed registration-confirmed reply; snapshot=%+v", rec.Snapshot())
	}
	t.Logf("captured register reply: kind=%s msg=%q", got.Kind, got.Message)

	e2e.WriteFixture(t, "anope", "register-no-confirm", ircdLabel, rec.Snapshot())
}

// ---------------------------------------------------------------------
// Scenario: identify-success — register, disconnect, reconnect, IDENTIFY.
// ---------------------------------------------------------------------
func TestAnope_IdentifySuccess(t *testing.T) {
	host, port := ircAddr()
	nick := uniqueNick("e2eidok")
	password := "hunter2-" + uniqueNick("p")
	email := "nobody@test.invalid"

	// Phase 1: register.
	{
		client, _, teardown := e2e.ConnectAndWait(t, irc.Config{
			Hostname: host, Port: port, TLS: false,
			Nick: nick, User: nick, RealName: nick,
		})
		e2e.NickservMsg(t, client, fmt.Sprintf("REGISTER %s %s", password, email))
		time.Sleep(500 * time.Millisecond)
		teardown()
	}

	// Phase 2: reconnect + IDENTIFY.
	client, rec, teardown := e2e.ConnectAndWait(t, irc.Config{
		Hostname: host, Port: port, TLS: false,
		Nick: nick, User: nick, RealName: nick,
	})
	defer teardown()

	e2e.NickservMsg(t, client, "IDENTIFY "+password)

	got, ok := rec.WaitForMatch(5*time.Second, func(e e2e.CapturedEvent) bool {
		body := strings.ToLower(e.Message)
		return strings.Contains(body, "password accepted") ||
			strings.Contains(body, "now identified") ||
			strings.Contains(body, "now recognized") ||
			e.Kind == "900"
	})
	if !ok {
		t.Fatalf("never observed identify-success reply; snapshot=%+v", rec.Snapshot())
	}
	t.Logf("captured identify reply: kind=%s msg=%q", got.Kind, got.Message)

	e2e.WriteFixture(t, "anope", "identify-success", ircdLabel, rec.Snapshot())
}

// ---------------------------------------------------------------------
// Scenario: identify-wrong-password.
// ---------------------------------------------------------------------
func TestAnope_IdentifyWrongPassword(t *testing.T) {
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
		return strings.Contains(body, "password incorrect") ||
			strings.Contains(body, "invalid password") ||
			strings.Contains(body, "authentication failed")
	})
	if !ok {
		t.Fatalf("never observed identify-failed reply; snapshot=%+v", rec.Snapshot())
	}
	t.Logf("captured wrong-password reply: %q", got.Message)

	e2e.WriteFixture(t, "anope", "identify-wrong-password", ircdLabel, rec.Snapshot())
}

// ---------------------------------------------------------------------
// Scenario: info — INFO on a registered nick.
// ---------------------------------------------------------------------
func TestAnope_Info(t *testing.T) {
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
		return strings.Contains(body, "is ") ||
			strings.Contains(body, "registered:") ||
			strings.Contains(body, "online from")
	})
	if !ok {
		t.Fatalf("never observed INFO reply; snapshot=%+v", rec.Snapshot())
	}
	t.Logf("captured INFO reply: %q", got.Message)

	e2e.WriteFixture(t, "anope", "info", ircdLabel, rec.Snapshot())
}

// ---------------------------------------------------------------------
// Scenario: drop-success — Anope 2.0's `DROP <nick>` deletes the
// account in one round-trip when called by the identified owner.
// ---------------------------------------------------------------------
func TestAnope_DropSuccess(t *testing.T) {
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
	// Single-arg DROP — canonical Anope 2.0 ns_drop syntax. Production
	// operator-patched variants (irc.boson.chat) require 2 args and
	// the renderer auto-retries via the drop-needs-password classifier
	// kind, but vanilla anope/anope:latest (this container) takes 1.
	e2e.NickservMsg(t, client, "DROP "+nick)

	got, ok := rec.WaitForMatch(5*time.Second, func(e e2e.CapturedEvent) bool {
		body := strings.ToLower(e.Message)
		return strings.Contains(body, "has been dropped") ||
			strings.Contains(body, "is no longer registered")
	})
	if !ok {
		t.Fatalf("never observed drop-success reply; snapshot=%+v", rec.Snapshot())
	}
	t.Logf("captured drop reply: %q", got.Message)

	e2e.WriteFixture(t, "anope", "drop-success", ircdLabel, rec.Snapshot())
}

// ---------------------------------------------------------------------
// Scenario: drop-full-roundtrip — same shape as the Atheme version.
// Captures EVERYTHING Anope emits during + after DROP, including any
// post-success notices that might trip the renderer's
// service-confirm-replay regex into firing again. Diagnostic for the
// post-drop loop the user reported.
// ---------------------------------------------------------------------
func TestAnope_DropFullRoundtrip(t *testing.T) {
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
	preDrop := len(rec.Snapshot())
	e2e.NickservMsg(t, client, "DROP "+nick)

	// 3-second tail to see EVERY post-DROP message.
	time.Sleep(3 * time.Second)
	post := rec.Snapshot()[preDrop:]
	t.Logf("captured %d events after DROP:", len(post))
	for i, e := range post {
		t.Logf("  [%d] %s from %s: %q", i, e.Kind, e.From, e.Message)
	}

	e2e.WriteFixture(t, "anope", "drop-full-roundtrip", ircdLabel, rec.Snapshot())
}
