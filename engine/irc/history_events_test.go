package irc

import (
	"strings"
	"testing"
	"time"

	"github.com/lrstanley/girc"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// feed runs lines through one connection's history tracker, as the reader
// would, and returns what girc would be handed.
func feed(h *historyBatches, lines ...string) []string {
	out := make([]string, 0, len(lines))
	for _, l := range lines {
		raw := []byte(l + "\r\n")
		out = append(out, strings.TrimRight(string(h.rewrite(raw, girc.ParseEvent(string(raw)))), "\r\n"))
	}
	return out
}

func TestHistoryBatches_RenamesStateEventsInHistoryBatches(t *testing.T) {
	got := feed(newHistoryBatches(),
		"@time=2026-11-26T10:00:00.000Z :ergo.test BATCH +h1 chathistory #chan",
		"@batch=h1;msgid=a;time=2026-11-26T10:00:01.000Z :bob!b@h JOIN #chan bob :Bob",
		"@batch=h1 :bob!b@h PART #chan :bye",
		"@batch=h1 :bob!b@h QUIT :Quit: shutting down",
		"@batch=h1 :op!o@h KICK #chan bob :out",
		"@batch=h1 :tester!t@h NICK tester2",
		"@batch=h1 :op!o@h TOPIC #chan :new topic",
		"@batch=h1 :op!o@h MODE #chan +o bob",
		"@batch=h1;+typing=active :bob!b@h TAGMSG #chan",
		"@batch=h1 :bob!b@h PRIVMSG #chan :hi",
		":ergo.test BATCH -h1",
		// After the batch: live again.
		":bob!b@h JOIN #chan",
	)
	assert.Equal(t, []string{
		"@time=2026-11-26T10:00:00.000Z :ergo.test BATCH +h1 chathistory #chan",
		"@batch=h1;msgid=a;time=2026-11-26T10:00:01.000Z :bob!b@h HISTORY_JOIN #chan bob :Bob",
		"@batch=h1 :bob!b@h HISTORY_PART #chan :bye",
		"@batch=h1 :bob!b@h HISTORY_QUIT :Quit: shutting down",
		"@batch=h1 :op!o@h HISTORY_KICK #chan bob :out",
		"@batch=h1 :tester!t@h HISTORY_NICK tester2",
		"@batch=h1 :op!o@h HISTORY_TOPIC #chan :new topic",
		"@batch=h1 :op!o@h HISTORY_MODE #chan +o bob",
		"@batch=h1;+typing=active :bob!b@h TAGMSG #chan",
		"@batch=h1 :bob!b@h PRIVMSG #chan :hi",
		":ergo.test BATCH -h1",
		":bob!b@h JOIN #chan",
	}, got)
}

func TestHistoryBatches_LeavesOtherBatchesLive(t *testing.T) {
	// A netsplit batch's QUITs are happening now: girc must see them.
	got := feed(newHistoryBatches(),
		":ergo.test BATCH +n1 netsplit a.test b.test",
		"@batch=n1 :bob!b@h QUIT :a.test b.test",
		":ergo.test BATCH -n1",
	)
	assert.Equal(t, "@batch=n1 :bob!b@h QUIT :a.test b.test", got[1])
}

func TestHistoryBatches_NestedAndDraftTypes(t *testing.T) {
	got := feed(newHistoryBatches(),
		":ergo.test BATCH +outer draft/chathistory #chan",
		"@batch=outer :ergo.test BATCH +inner something",
		"@batch=inner :bob!b@h JOIN #chan",
		":ergo.test BATCH -inner",
		":ergo.test BATCH -outer",
		"@batch=inner :bob!b@h JOIN #chan",
	)
	assert.Equal(t, "@batch=inner :bob!b@h HISTORY_JOIN #chan", got[2])
	assert.Equal(t, "@batch=inner :bob!b@h JOIN #chan", got[5], "a closed ref is live again")
}

func TestHistoryEventCommand(t *testing.T) {
	cmd, ok := historyEventCommand("HISTORY_JOIN")
	assert.True(t, ok)
	assert.Equal(t, "JOIN", cmd)
	_, ok = historyEventCommand("JOIN")
	assert.False(t, ok)
	_, ok = historyEventCommand("HISTORY_PRIVMSG")
	assert.False(t, ok, "only the commands rewrite renames")
}

func TestCommandOffset(t *testing.T) {
	assert.Equal(t, 0, commandOffset([]byte("PING :x\r\n")))
	assert.Equal(t, 7, commandOffset([]byte(":a!b@c JOIN #x\r\n")))
	assert.Equal(t, 14, commandOffset([]byte("@batch=1 :a!b JOIN #x\r\n")))
	assert.Equal(t, -1, commandOffset([]byte(":a!b@c\r\n")))
}

// End to end through girc: replayed events reach the renderer under their
// real command with the batch tag, but change none of girc's state and fire
// none of the live JOIN work.
func TestHistoryEvents_ForwardedWithoutTouchingState(t *testing.T) {
	c, srv, rec := startBouncerClient(t, nil)
	srv.send(upstreamBurst...)
	srv.send(":tester!t@h JOIN #chan")
	srv.waitCount("WHO #chan", 1)
	require.Eventually(t, func() bool { return c.girc.IsInChannel("#chan") }, 3*time.Second, 5*time.Millisecond)

	srv.send(
		":ergo.test BATCH +h1 chathistory #chan",
		"@batch=h1;msgid=m1;time=2026-11-26T10:00:00.000Z :tester!t@h JOIN #chan",
		"@batch=h1;msgid=m2 :tester!t@h NICK someoneelse",
		"@batch=h1;msgid=m3 :tester!t@h PART #chan :old",
		"@batch=h1;msgid=m4 :bob!b@h QUIT :Quit: shutting down",
		"@batch=h1;msgid=m5;+typing=active :bob!b@h TAGMSG #chan",
		":ergo.test BATCH -h1",
		":ergo.test PING :done",
	)
	srv.waitCount("PONG done", 1)
	settle()

	assert.Equal(t, "tester", c.girc.GetNick(), "a replayed NICK doesn't rename us")
	assert.True(t, c.girc.IsInChannel("#chan"), "a replayed self-PART doesn't drop the channel")
	assert.Equal(t, 1, srv.count("WHO #chan"), "a replayed self-JOIN sends no WHO")

	rec.mu.Lock()
	defer rec.mu.Unlock()
	byID := map[string]Event{}
	for _, e := range rec.events {
		if id := e.Tags["msgid"]; id != "" {
			byID[id] = e
		}
	}
	for id, kind := range map[string]string{"m1": "JOIN", "m2": "NICK", "m3": "PART", "m4": "QUIT", "m5": "TAGMSG"} {
		e, ok := byID[id]
		if assert.True(t, ok, "%s forwarded", id) {
			assert.Equal(t, kind, e.Kind, id)
			assert.Equal(t, "h1", e.Tags["batch"], id)
			assert.NotContains(t, e.Raw, historyCmdPrefix, id)
		}
	}
	assert.Equal(t, "#chan", byID["m1"].Target)
	assert.Equal(t, "someoneelse", byID["m2"].Message)
	assert.Equal(t, "Quit: shutting down", byID["m4"].Message)
	assert.Equal(t, "active", byID["m5"].Tags["+typing"])
}

func TestSupportedCaps_EventPlayback(t *testing.T) {
	c, err := New(Config{Hostname: "irc.example", Port: 6697, Nick: "tester"})
	require.NoError(t, err)
	assert.Contains(t, c.girc.Config.SupportedCaps, "draft/event-playback")
	assert.Contains(t, c.girc.Config.SupportedCaps, "event-playback")
}
