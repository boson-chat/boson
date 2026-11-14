package irc

import (
	"encoding/base64"
	"strings"
	"sync"

	"github.com/lrstanley/girc"
)

// SASLOAuthBearer logs in with an access token from the network's own auth
// service (RFC 7628 OAUTHBEARER), as the boson stack's Ergo accepts. The
// token is short-lived: the renderer hands a fresh one to every connect.
type SASLOAuthBearer struct {
	Token string
}

const (
	mechOAuthBearer = "OAUTHBEARER"
	mechPlain       = "PLAIN"
	// saslChunk is the IRCv3 AUTHENTICATE line limit: a payload is sent in
	// 400-byte pieces, and a shorter (or "+") line ends it.
	saslChunk = 400
)

// saslMech picks OAUTHBEARER (with a token) or PLAIN (a user-entered
// password): PLAIN only when there's no token, or when the server's CAP LS
// says it doesn't offer OAUTHBEARER. It also works around girc's chunking,
// which sends 399-byte pieces and drops a byte from each, so any payload
// over 400 bytes (every JWT) would arrive corrupt: full 400-byte pieces go
// out from Encode itself, and girc only sends the last one.
type saslMech struct {
	bearer *SASLOAuthBearer
	plain  *SASLPlain
	// send writes one AUTHENTICATE line (set once the girc client exists).
	send func(chunk string)

	mu sync.Mutex
	// offered: the server's sasl=… mechanism list from CAP LS (nil: it
	// didn't say).
	offered []string
	chosen  string
}

func newSASLMech(bearer *SASLOAuthBearer, plain *SASLPlain) *saslMech {
	if bearer != nil && bearer.Token == "" {
		bearer = nil
	}
	if bearer == nil && plain == nil {
		return nil
	}
	return &saslMech{bearer: bearer, plain: plain}
}

// onCapLS records the mechanisms a server advertises (sasl=A,B).
func (m *saslMech) onCapLS(e girc.Event) {
	if len(e.Params) < 2 || (e.Params[1] != girc.CAP_LS && e.Params[1] != girc.CAP_NEW) {
		return
	}
	for _, c := range strings.Fields(e.Last()) {
		if v, ok := strings.CutPrefix(c, "sasl="); ok {
			m.mu.Lock()
			m.offered = strings.Split(strings.ToUpper(v), ",")
			m.mu.Unlock()
		}
	}
}

func (m *saslMech) offers(mech string) bool {
	if m.offered == nil {
		return true // not advertised: try it
	}
	for _, o := range m.offered {
		if o == mech {
			return true
		}
	}
	return false
}

func (m *saslMech) Method() string {
	m.mu.Lock()
	defer m.mu.Unlock()
	switch {
	case m.bearer != nil && (m.plain == nil || m.offers(mechOAuthBearer)):
		m.chosen = mechOAuthBearer
	default:
		m.chosen = mechPlain
	}
	return m.chosen
}

func (m *saslMech) payload() string {
	m.mu.Lock()
	chosen := m.chosen
	m.mu.Unlock()
	if chosen == mechOAuthBearer && m.bearer != nil {
		return oauthBearerPayload(m.bearer.Token)
	}
	if m.plain != nil {
		return (&girc.SASLPlain{User: m.plain.User, Pass: m.plain.Password}).Encode([]string{"+"})
	}
	return ""
}

// oauthBearerPayload is the RFC 7628 client response, base64: a GS2
// header without an authzid (the account is the token's subject) and the
// bearer token.
func oauthBearerPayload(token string) string {
	return base64.StdEncoding.EncodeToString([]byte("n,,\x01auth=Bearer " + token + "\x01\x01"))
}

func (m *saslMech) Encode(params []string) string {
	if len(params) != 1 || params[0] != "+" {
		return ""
	}
	out := m.payload()
	if out == "" {
		return ""
	}
	pieces := saslPieces(out)
	for _, p := range pieces[:len(pieces)-1] {
		m.send(p)
	}
	// girc sends this one, plus "AUTHENTICATE +" when it's exactly 400.
	return pieces[len(pieces)-1]
}

// saslPieces splits a payload into AUTHENTICATE pieces: 400 bytes each and a
// last one of 1..400 (girc adds the "+" after an exact 400).
func saslPieces(s string) []string {
	var out []string
	for len(s) > saslChunk {
		out = append(out, s[:saslChunk])
		s = s[saslChunk:]
	}
	return append(out, s)
}
