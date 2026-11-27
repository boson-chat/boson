package irc

import (
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
)

// The engine renames on its own only while registering: the server needs
// some nick (nick_ after 433). Once welcomed, a refusal answers a NICK the
// user sent, and the connection keeps its nick — on a bouncer that nick is
// the one every device of the user's shares.

func TestNickCollide_RegistrationFallsBackToUnderscore(t *testing.T) {
	_, srv, _ := startBouncerClient(t, nil)
	srv.send(":irc.test 433 * tester :Nickname is already in use")
	srv.waitCount("NICK tester_", 1)
}

func TestNickCollide_AfterWelcomeSendsNothing(t *testing.T) {
	_, srv, rec := startBouncerClient(t, nil)
	// A bridge welcomes us under the shared connection's nick (device A
	// picked TheLion); this device registered as tester.
	srv.send(":bridge.test 001 TheLion :Welcome", ":bridge.test 422 TheLion :MOTD File is missing")
	assert.Eventually(t, func() bool { return rec.eventKinds("001") >= 1 }, 3*time.Second, 5*time.Millisecond)
	// The user's /nick to a taken nick is refused, as is one of their
	// collisions: none of it may rename the connection.
	srv.send(
		":bridge.test 433 TheLion Taken :Nickname is already in use",
		":bridge.test 436 TheLion Other :Nickname collision",
		":bridge.test 437 TheLion Held :Nick/channel is temporarily unavailable",
	)
	assert.Eventually(t, func() bool { return rec.eventKinds("437") >= 1 }, 3*time.Second, 5*time.Millisecond)
	settle()
	assert.Equal(t, 1, srv.count("NICK tester"), "registration")
	assert.Equal(t, 1, srv.countPrefix("NICK "), "no NICK after the welcome")
}

func TestNickCollide_OnlyBeforeWelcome(t *testing.T) {
	c := &Client{}
	assert.Equal(t, "a_", c.nickCollide("a"))
	c.registered.Store(true)
	assert.Equal(t, "", c.nickCollide("a"))
}
