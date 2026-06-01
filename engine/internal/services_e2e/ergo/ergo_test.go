//go:build e2e

// Ergo e2e: drives REGISTER → IDENTIFY → INFO → DROP against a local
// Ergo container and writes the captured NickServ chatter to
// fixtures/ergo/<scenario>.json for the renderer's classifier tests
// to assert against.
//
// Run via:
//
//	make test-e2e-ergo
//
// which starts the `ergo` profile in docker-compose.yml and then
// invokes `go test -tags=e2e ./engine/internal/services_e2e/ergo/...`.
//
// Skipped entirely when the e2e build tag isn't set (default).
package ergo_test

import (
	"fmt"
	"os"
	"strings"
	"testing"
	"time"

	e2e "github.com/boson-chat/boson/engine/internal/services_e2e"
	"github.com/boson-chat/boson/engine/irc"
)

const ircdLabel = "ergo-stable"

// nickservAddr derives the IRC endpoint from env. Lets the same code
// run against a local docker stack OR a CI runner with port-forwards.
func ircAddr() (string, int) {
	host := os.Getenv("E2E_ERGO_HOST")
	if host == "" {
		host = "127.0.0.1"
	}
	port := 6667
	if v := os.Getenv("E2E_ERGO_PORT"); v != "" {
		fmt.Sscanf(v, "%d", &port)
	}
	return host, port
}

// uniqueNick returns a per-test nick like "boson_t1700123456" so
// repeated runs don't collide on the server's nick reservation
// table. Tests own cleanup via DROP; the suffix is insurance.
func uniqueNick(prefix string) string {
	return fmt.Sprintf("%s%d", prefix, time.Now().UnixNano()%1_000_000_000)
}

// ---------------------------------------------------------------------
// Scenario: register-no-confirm
//
// Ergo's `enabled-callbacks: [none]` config makes REGISTER complete in
// one round-trip — no email step. The reply ought to land as
// "Account created" (registration-confirmed in the classifier).
// ---------------------------------------------------------------------
func TestErgo_RegisterNoConfirm(t *testing.T) {
	host, port := ircAddr()
	nick := uniqueNick("e2ereg")
	password := "hunter2-" + uniqueNick("p")

	client, rec, teardown := e2e.ConnectAndWait(t, irc.Config{
		Hostname: host, Port: port, TLS: false,
		Nick: nick, User: nick, RealName: nick,
	})
	defer teardown()

	// REGISTER on Ergo: NickServ REGISTER <password> [<email>]. Email
	// arg is optional + ignored when callbacks=none.
	e2e.NickservMsg(t, client, "REGISTER "+password)

	got, ok := rec.WaitForMatch(5*time.Second, func(e e2e.CapturedEvent) bool {
		body := strings.ToLower(e.Message)
		return strings.Contains(body, "account created") || strings.Contains(body, "registration")
	})
	if !ok {
		t.Fatalf("never observed registration-confirmed reply; snapshot=%+v", rec.Snapshot())
	}
	t.Logf("captured registration reply: %q", got.Message)

	e2e.WriteFixture(t, "ergo", "register-no-confirm", ircdLabel, rec.Snapshot())
}

// ---------------------------------------------------------------------
// Scenario: identify-success — register, disconnect, reconnect, IDENTIFY.
// ---------------------------------------------------------------------
func TestErgo_IdentifySuccess(t *testing.T) {
	host, port := ircAddr()
	nick := uniqueNick("e2eidok")
	password := "hunter2-" + uniqueNick("p")

	// Phase 1: register.
	{
		client, _, teardown := e2e.ConnectAndWait(t, irc.Config{
			Hostname: host, Port: port, TLS: false,
			Nick: nick, User: nick, RealName: nick,
		})
		e2e.NickservMsg(t, client, "REGISTER "+password)
		// Let the reply land.
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
		return strings.Contains(body, "logged in") || e.Kind == "900"
	})
	if !ok {
		t.Fatalf("never observed identify-success reply; snapshot=%+v", rec.Snapshot())
	}
	t.Logf("captured identify reply: kind=%s msg=%q", got.Kind, got.Message)

	e2e.WriteFixture(t, "ergo", "identify-success", ircdLabel, rec.Snapshot())
}

// ---------------------------------------------------------------------
// Scenario: identify-wrong-password.
// ---------------------------------------------------------------------
func TestErgo_IdentifyWrongPassword(t *testing.T) {
	host, port := ircAddr()
	nick := uniqueNick("e2eidko")
	password := "hunter2-" + uniqueNick("p")

	// Phase 1: register.
	{
		client, _, teardown := e2e.ConnectAndWait(t, irc.Config{
			Hostname: host, Port: port, TLS: false,
			Nick: nick, User: nick, RealName: nick,
		})
		e2e.NickservMsg(t, client, "REGISTER "+password)
		time.Sleep(500 * time.Millisecond)
		teardown()
	}

	// Phase 2: reconnect + IDENTIFY with WRONG password.
	client, rec, teardown := e2e.ConnectAndWait(t, irc.Config{
		Hostname: host, Port: port, TLS: false,
		Nick: nick, User: nick, RealName: nick,
	})
	defer teardown()

	e2e.NickservMsg(t, client, "IDENTIFY wrong-password-xyzzy")

	got, ok := rec.WaitForMatch(5*time.Second, func(e e2e.CapturedEvent) bool {
		body := strings.ToLower(e.Message)
		return strings.Contains(body, "authentication failed") || strings.Contains(body, "invalid")
	})
	if !ok {
		t.Fatalf("never observed identify-failed reply; snapshot=%+v", rec.Snapshot())
	}
	t.Logf("captured wrong-password reply: %q", got.Message)

	e2e.WriteFixture(t, "ergo", "identify-wrong-password", ircdLabel, rec.Snapshot())
}

// ---------------------------------------------------------------------
// Scenario: info — INFO on a registered nick shows status + email.
// ---------------------------------------------------------------------
func TestErgo_Info(t *testing.T) {
	host, port := ircAddr()
	nick := uniqueNick("e2einfo")
	password := "hunter2-" + uniqueNick("p")

	// Register, identify, then INFO.
	client, rec, teardown := e2e.ConnectAndWait(t, irc.Config{
		Hostname: host, Port: port, TLS: false,
		Nick: nick, User: nick, RealName: nick,
	})
	defer teardown()

	e2e.NickservMsg(t, client, "REGISTER "+password)
	time.Sleep(500 * time.Millisecond)
	e2e.NickservMsg(t, client, "INFO "+nick)

	got, ok := rec.WaitForMatch(5*time.Second, func(e e2e.CapturedEvent) bool {
		body := strings.ToLower(e.Message)
		return strings.Contains(body, "account:") || strings.Contains(body, "registered") || strings.Contains(body, "logged in")
	})
	if !ok {
		t.Fatalf("never observed INFO reply; snapshot=%+v", rec.Snapshot())
	}
	t.Logf("captured INFO reply: %q", got.Message)

	e2e.WriteFixture(t, "ergo", "info", ircdLabel, rec.Snapshot())
}

// ---------------------------------------------------------------------
// Scenario: drop-confirm-prompt — capture Ergo's two-step UNREGISTER
// confirmation message. The follow-through to actual deletion has
// timing nuances worth a dedicated scenario; for now the prompt
// itself is what the classifier needs to recognise.
// ---------------------------------------------------------------------
func TestErgo_DropConfirmPrompt(t *testing.T) {
	host, port := ircAddr()
	nick := uniqueNick("e2edrop")
	password := "hunter2-" + uniqueNick("p")

	client, rec, teardown := e2e.ConnectAndWait(t, irc.Config{
		Hostname: host, Port: port, TLS: false,
		Nick: nick, User: nick, RealName: nick,
	})
	defer teardown()

	e2e.NickservMsg(t, client, "REGISTER "+password)
	time.Sleep(500 * time.Millisecond)
	// Ergo uses UNREGISTER (not DROP — verified live on stable build).
	// The first call returns a confirmation-token prompt: "To confirm,
	// run this command: /NS UNREGISTER <account> <token>". Capture
	// the prompt as the scenario fixture — the second-step follow-
	// through has timing nuances (token must be re-sent within Ergo's
	// confirmation window, sometimes via a different IRC verb shape
	// across versions) that warrant a dedicated scenario. The captured
	// prompt body is enough for the classifier to verify it lands as
	// drop-confirm-prompt-ish.
	e2e.NickservMsg(t, client, "UNREGISTER "+nick)
	got, ok := rec.WaitForMatch(5*time.Second, func(e e2e.CapturedEvent) bool {
		return strings.Contains(strings.ToLower(e.Message), "to confirm")
	})
	if !ok {
		t.Fatalf("never observed UNREGISTER confirm prompt; snapshot=%+v", rec.Snapshot())
	}
	t.Logf("captured UNREGISTER confirm prompt: %q", got.Message)
	e2e.WriteFixture(t, "ergo", "drop-confirm-prompt", ircdLabel, rec.Snapshot())
}
