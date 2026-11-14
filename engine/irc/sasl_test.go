package irc

import (
	"bufio"
	"context"
	"encoding/base64"
	"net"
	"strings"
	"testing"
	"time"

	"github.com/lrstanley/girc"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestOAuthBearerPayload(t *testing.T) {
	raw, err := base64.StdEncoding.DecodeString(oauthBearerPayload("tok.en.sig"))
	require.NoError(t, err)
	assert.Equal(t, "n,,\x01auth=Bearer tok.en.sig\x01\x01", string(raw))
}

func TestSASLPieces(t *testing.T) {
	assert.Equal(t, []string{"abc"}, saslPieces("abc"))
	exact := strings.Repeat("a", 400)
	assert.Equal(t, []string{exact}, saslPieces(exact), "an exact 400 stays one piece (girc adds the +)")
	long := strings.Repeat("a", 400) + strings.Repeat("b", 400) + "c"
	assert.Equal(t, []string{strings.Repeat("a", 400), strings.Repeat("b", 400), "c"}, saslPieces(long))
	twice := strings.Repeat("x", 800)
	assert.Equal(t, []string{strings.Repeat("x", 400), strings.Repeat("x", 400)}, saslPieces(twice))
}

func capLS(list string) girc.Event {
	return girc.Event{Command: girc.CAP, Params: []string{"*", "LS", list}}
}

func TestSASLMech_PicksMechanism(t *testing.T) {
	bearer := &SASLOAuthBearer{Token: "t"}
	plain := &SASLPlain{User: "u", Password: "p"}

	m := newSASLMech(bearer, nil)
	assert.Equal(t, "OAUTHBEARER", m.Method(), "a token alone is always OAUTHBEARER")

	m = newSASLMech(bearer, plain)
	assert.Equal(t, "OAUTHBEARER", m.Method(), "unadvertised mechanisms: the token first")
	m.onCapLS(capLS("sasl=PLAIN,EXTERNAL message-tags"))
	assert.Equal(t, "PLAIN", m.Method(), "no OAUTHBEARER on offer: the user's password")
	m.onCapLS(capLS("sasl=PLAIN,OAUTHBEARER"))
	assert.Equal(t, "OAUTHBEARER", m.Method())

	m = newSASLMech(bearer, nil)
	m.onCapLS(capLS("sasl=PLAIN"))
	assert.Equal(t, "OAUTHBEARER", m.Method(), "never PLAIN without a password the user gave")
}

func TestSASLMech_EncodeOnlyAnswersTheEmptyChallenge(t *testing.T) {
	m := newSASLMech(&SASLOAuthBearer{Token: "t"}, nil)
	m.Method()
	assert.Equal(t, "", m.Encode([]string{"something"}))
}

// saslServer runs a CAP/SASL exchange like Ergo's: it advertises sasl, ACKs
// it, reassembles the AUTHENTICATE pieces and checks the result with
// accept, then welcomes the client (903) or refuses it (904).
func saslServer(t *testing.T, mechs string, accept func(mech, payload string) bool) (port int, got chan [2]string) {
	t.Helper()
	l, err := net.Listen("tcp", "127.0.0.1:0")
	require.NoError(t, err)
	t.Cleanup(func() { _ = l.Close() })
	got = make(chan [2]string, 1)
	go func() {
		cn, err := l.Accept()
		if err != nil {
			return
		}
		t.Cleanup(func() { _ = cn.Close() })
		w := func(s string) { _, _ = cn.Write([]byte(s + "\r\n")) }
		sc := bufio.NewScanner(cn)
		var mech, buf string
		for sc.Scan() {
			line := sc.Text()
			switch {
			case strings.HasPrefix(line, "CAP LS"):
				w(":srv CAP * LS :sasl=" + mechs + " message-tags")
			case strings.HasPrefix(line, "CAP REQ"):
				w(":srv CAP * ACK :" + strings.TrimPrefix(strings.SplitN(line, ":", 2)[1], ""))
			case strings.HasPrefix(line, "AUTHENTICATE "):
				arg := strings.TrimPrefix(line, "AUTHENTICATE ")
				if mech == "" {
					mech = arg
					w(":srv AUTHENTICATE +")
					continue
				}
				if arg != "+" {
					if len(arg) > 400 {
						w(":srv 904 * :SASL authentication failed (line too long)")
						continue
					}
					buf += arg
				}
				if len(arg) == 400 {
					continue // more to come
				}
				dec, _ := base64.StdEncoding.DecodeString(buf)
				got <- [2]string{mech, string(dec)}
				if accept(mech, string(dec)) {
					w(":srv 900 tester tester!t@h alice :You are now logged in as alice")
					w(":srv 903 tester :SASL authentication successful")
				} else {
					w(":srv 904 tester :SASL authentication failed")
				}
			case strings.HasPrefix(line, "CAP END"):
				w(":srv 001 tester :Welcome")
			}
		}
	}()
	return l.Addr().(*net.TCPAddr).Port, got
}

func TestConnect_OAuthBearerSendsALongTokenIntact(t *testing.T) {
	// An access token is a JWT of several hundred bytes: base64 makes it
	// span several 400-byte AUTHENTICATE lines.
	for _, n := range []int{10, 296, 297, 600, 1200} {
		token := strings.Repeat("A", n) + ".payload.sig"
		port, got := saslServer(t, "PLAIN,OAUTHBEARER", func(mech, p string) bool {
			return mech == "OAUTHBEARER" && p == "n,,\x01auth=Bearer "+token+"\x01\x01"
		})
		c, err := New(Config{Hostname: "127.0.0.1", Port: port, Nick: "tester", OAuthBearer: &SASLOAuthBearer{Token: token}})
		require.NoError(t, err)
		welcomed := make(chan struct{}, 1)
		c.OnEvent(func(e Event) {
			if e.Kind == "001" {
				select {
				case welcomed <- struct{}{}:
				default:
				}
			}
		})
		ctx, cancel := context.WithCancel(context.Background())
		done := make(chan error, 1)
		go func() { done <- c.Connect(ctx) }()
		select {
		case g := <-got:
			assert.Equal(t, "OAUTHBEARER", g[0])
			assert.Equal(t, "n,,\x01auth=Bearer "+token+"\x01\x01", g[1], "token of %d bytes", n)
		case <-time.After(5 * time.Second):
			t.Fatalf("no SASL exchange (token %d bytes)", n)
		}
		select {
		case <-welcomed:
		case err := <-done:
			t.Fatalf("connection ended before welcome: %v", err)
		case <-time.After(5 * time.Second):
			t.Fatal("not welcomed after SASL")
		}
		cancel()
		<-done
	}
}

func TestConnect_PlainFallbackWhenNoOAuthBearer(t *testing.T) {
	port, got := saslServer(t, "PLAIN", func(mech, p string) bool { return mech == "PLAIN" })
	c, err := New(Config{
		Hostname: "127.0.0.1", Port: port, Nick: "tester",
		OAuthBearer: &SASLOAuthBearer{Token: "tok"},
		SASL:        &SASLPlain{User: "alice", Password: "pw"},
	})
	require.NoError(t, err)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 1)
	go func() { done <- c.Connect(ctx) }()
	select {
	case g := <-got:
		assert.Equal(t, "PLAIN", g[0])
		assert.Equal(t, "alice\x00alice\x00pw", g[1])
	case <-time.After(5 * time.Second):
		t.Fatal("no SASL exchange")
	}
	cancel()
	<-done
}
