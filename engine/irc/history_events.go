package irc

import (
	"bytes"
	"strings"

	"github.com/lrstanley/girc"
)

// History events (draft/event-playback).
//
// With event-playback negotiated, a server replays a channel's JOIN, PART,
// QUIT, KICK, NICK, TOPIC, MODE and TAGMSG history as the real commands
// inside a chathistory batch (without it, Ergo turns them into PRIVMSGs from
// HistServ). Those are records of the past, not things happening now — but
// girc's built-in state tracking can't tell: a replayed `:me NICK old` would
// rename us, a replayed self-PART would drop the channel, a replayed
// self-JOIN would fire the WHO/MODE join work.
//
// So the reader renames them before girc sees them: inside a history batch,
// `JOIN` reaches girc as `HISTORY_JOIN`, a command none of its handlers know.
// The engine's event handler turns the name back (historyEventCommand) and
// forwards the event as usual, `batch` tag and all, so the renderer files it
// under the batch's conversation as history. TAGMSG and PRIVMSG/NOTICE carry
// no state girc tracks and pass through untouched.

// historyCmdPrefix marks a history event's command on its way through girc.
const historyCmdPrefix = "HISTORY_"

// historyBatchTypes are the batch types whose contents are backlog.
var historyBatchTypes = map[string]bool{
	"chathistory":       true,
	"draft/chathistory": true,
	"znc.in/playback":   true,
}

// historyStateCommands are the commands girc tracks state from.
var historyStateCommands = map[string]bool{
	girc.JOIN:  true,
	girc.PART:  true,
	girc.QUIT:  true,
	girc.KICK:  true,
	girc.NICK:  true,
	girc.TOPIC: true,
	girc.MODE:  true,
}

// historyBatches tracks the open history batch refs of one connection. Only
// the connection's reader touches it, so it isn't locked.
type historyBatches struct {
	refs map[string]struct{}
}

func newHistoryBatches() *historyBatches {
	return &historyBatches{refs: map[string]struct{}{}}
}

// inHistory: the event is inside an open history batch.
func (h *historyBatches) inHistory(ev *girc.Event) bool {
	ref, ok := ev.Tags.Get("batch")
	if !ok {
		return false
	}
	_, open := h.refs[ref]
	return open
}

// rewrite notes BATCH framing and returns line with a history event's
// command renamed (see above); any other line comes back as is.
func (h *historyBatches) rewrite(line []byte, ev *girc.Event) []byte {
	if ev == nil {
		return line
	}
	if ev.Command == "BATCH" {
		if len(ev.Params) == 0 {
			return line
		}
		ref := ev.Params[0]
		switch {
		case strings.HasPrefix(ref, "+") && len(ref) > 1:
			// A batch nested in a history batch is history too.
			if (len(ev.Params) >= 2 && historyBatchTypes[ev.Params[1]]) || h.inHistory(ev) {
				h.refs[ref[1:]] = struct{}{}
			}
		case strings.HasPrefix(ref, "-"):
			delete(h.refs, ref[1:])
		}
		return line
	}
	if !historyStateCommands[ev.Command] || !h.inHistory(ev) {
		return line
	}
	at := commandOffset(line)
	if at < 0 {
		return line
	}
	out := make([]byte, 0, len(line)+len(historyCmdPrefix))
	out = append(out, line[:at]...)
	out = append(out, historyCmdPrefix...)
	return append(out, line[at:]...)
}

// commandOffset is where the command starts in a raw line: after the
// `@tags` and `:source` words, if any. -1 when there's no command.
func commandOffset(line []byte) int {
	i := 0
	skipWord := func() {
		sp := bytes.IndexByte(line[i:], ' ')
		if sp < 0 {
			i = len(line)
			return
		}
		i += sp
		for i < len(line) && line[i] == ' ' {
			i++
		}
	}
	if i < len(line) && line[i] == '@' {
		skipWord()
	}
	if i < len(line) && line[i] == ':' {
		skipWord()
	}
	if i >= len(line) || line[i] == '\r' || line[i] == '\n' {
		return -1
	}
	return i
}

// historyEventCommand undoes rewrite's rename: the real command, and whether
// cmd was a renamed history event.
func historyEventCommand(cmd string) (string, bool) {
	if !strings.HasPrefix(cmd, historyCmdPrefix) {
		return cmd, false
	}
	real := strings.TrimPrefix(cmd, historyCmdPrefix)
	if !historyStateCommands[real] {
		return cmd, false
	}
	return real, true
}
