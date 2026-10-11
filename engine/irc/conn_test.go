package irc

import (
	"io"
	"net"
	"strings"
	"testing"
	"time"
)

// readAll drains r through the same path girc uses: line-by-line via a
// bufio-style reader. Here we just io.ReadAll the filtered stream and split.
func TestLineFilterConn_DropsUnparseableLines(t *testing.T) {
	// A server stream with good lines interleaved with the kinds of garbage
	// that make girc.ParseEvent return nil and kill the connection:
	//   - a bare blank line (\r\n)
	//   - a lone-char line
	//   - a whitespace-only line
	raw := strings.Join([]string{
		":irc.example.com 001 nick :Welcome",
		"", // blank → girc rejects
		"PING :abc",
		"x", // single char → girc rejects (len < 2 after CR trim)
		":nick!u@h PRIVMSG #chan :hello",
		" ", // whitespace-only, len < 2 → rejected
		":nick!u@h PRIVMSG #chan :bye",
	}, "\r\n") + "\r\n"

	server, client := net.Pipe()
	go func() {
		_, _ = io.WriteString(server, raw)
		_ = server.Close()
	}()

	fc := newLineFilterConn(client)
	_ = fc.SetReadDeadline(time.Now().Add(2 * time.Second))
	out, err := io.ReadAll(fc)
	if err != nil && err != io.EOF {
		t.Fatalf("read: %v", err)
	}

	got := string(out)
	// Every accepted line must survive, in order.
	for _, want := range []string{
		":irc.example.com 001 nick :Welcome",
		"PING :abc",
		":nick!u@h PRIVMSG #chan :hello",
		":nick!u@h PRIVMSG #chan :bye",
	} {
		if !strings.Contains(got, want) {
			t.Errorf("filtered stream missing %q\ngot:\n%s", want, got)
		}
	}
	// The garbage lines must be gone. A stray blank line would show as "\r\n\r\n".
	if strings.Contains(got, "\r\n\r\n") {
		t.Errorf("blank line leaked through:\n%q", got)
	}
	if strings.Contains(got, "\r\nx\r\n") {
		t.Errorf("single-char line leaked through:\n%q", got)
	}
	// And we didn't lose any real line.
	if n := strings.Count(got, "\r\n"); n != 4 {
		t.Errorf("expected 4 accepted lines, got %d:\n%q", n, got)
	}
}

func TestLineFilterConn_DropsGircSelfJoinQueries(t *testing.T) {
	server, client := net.Pipe()
	fc := newLineFilterConn(client)
	got := make(chan string, 1)
	go func() {
		b, _ := io.ReadAll(server)
		got <- string(b)
	}()
	writes := []string{
		"WHO #a %tacuhnr,1\r\n", // girc's self-JOIN WHOX → dropped
		"MODE #a\r\n",           // ...and its MODE → dropped
		"MODE #a\r\n",           // a second (ours, queued) → sent
		"MODE #b\r\n",           // a MODE query with no WHOX before it → sent
		"WHO #a\r\n",            // plain WHO → sent
		"PRIVMSG #a :hel",       // a line split across writes is reassembled
		"lo\r\nWHO #c %tacuhnr,1\r\nMODE #C\r\n",
	}
	for _, w := range writes {
		n, err := fc.Write([]byte(w))
		if err != nil || n != len(w) {
			t.Fatalf("write %q: n=%d err=%v", w, n, err)
		}
	}
	_ = client.Close()
	want := "MODE #a\r\nMODE #b\r\nWHO #a\r\nPRIVMSG #a :hello\r\n"
	if g := <-got; g != want {
		t.Fatalf("wire:\n%q\nwant:\n%q", g, want)
	}
}
