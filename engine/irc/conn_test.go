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
