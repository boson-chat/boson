package supabaseimport

import (
	"strconv"
	"strings"
)

// These mirror github.com/boson-chat/auth/internal/nick, which decides
// whether the auth service accepts a username. Keep them in sync.

const nickMaxLen = 30

var reservedNicks = map[string]struct{}{}

func init() {
	for _, n := range []string{
		"nickserv", "chanserv", "memoserv", "operserv", "hostserv", "botserv",
		"global", "services", "statserv", "helpserv", "saslserv", "irc", "server", "root",
	} {
		reservedNicks[foldNick(n)] = struct{}{}
	}
}

func isLetter(c byte) bool  { return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') }
func isDigit(c byte) bool   { return c >= '0' && c <= '9' }
func isSpecial(c byte) bool { return strings.IndexByte("[]\\`_^{|}", c) >= 0 }

// validNick reports whether the auth service accepts s as a username.
func validNick(s string) bool {
	if s == "" || len(s) > nickMaxLen {
		return false
	}
	if c := s[0]; !isLetter(c) && !isSpecial(c) {
		return false
	}
	for i := 1; i < len(s); i++ {
		c := s[i]
		if !isLetter(c) && !isDigit(c) && !isSpecial(c) && c != '-' {
			return false
		}
	}
	_, reserved := reservedNicks[foldNick(s)]
	return !reserved
}

// foldNick is RFC 1459 casemapping, the auth service's uniqueness key.
func foldNick(s string) string {
	b := []byte(s)
	for i, c := range b {
		switch {
		case c >= 'A' && c <= 'Z':
			b[i] = c + ('a' - 'A')
		case c == '[':
			b[i] = '{'
		case c == ']':
			b[i] = '}'
		case c == '\\':
			b[i] = '|'
		case c == '~':
			b[i] = '^'
		}
	}
	return string(b)
}

// sanitizeNick turns arbitrary text into a valid nick, or "" when nothing
// usable is left: runs of disallowed characters become one '_', a leading
// digit or '-' gets a "u" prefix, the result is cut to 30 characters, and a
// reserved name gets a trailing '_'.
func sanitizeNick(s string) string {
	var b strings.Builder
	lastUnderscore := false
	for i := 0; i < len(s); i++ {
		c := s[i]
		if isLetter(c) || isDigit(c) || isSpecial(c) || c == '-' {
			b.WriteByte(c)
			lastUnderscore = c == '_'
			continue
		}
		if !lastUnderscore && b.Len() > 0 {
			b.WriteByte('_')
			lastUnderscore = true
		}
	}
	out := strings.TrimRight(b.String(), "_")
	if out == "" {
		return ""
	}
	if c := out[0]; isDigit(c) || c == '-' {
		out = "u" + out
	}
	if len(out) > nickMaxLen {
		out = strings.TrimRight(out[:nickMaxLen], "_-")
	}
	if _, reserved := reservedNicks[foldNick(out)]; reserved {
		if len(out) >= nickMaxLen {
			out = out[:nickMaxLen-1]
		}
		out += "_"
	}
	if !validNick(out) {
		return ""
	}
	return out
}

// uniqueNick returns base, or base with the smallest numeric suffix (2, 3,
// …) whose fold isn't in taken. base must be valid.
func uniqueNick(base string, taken map[string]struct{}) string {
	if _, ok := taken[foldNick(base)]; !ok {
		return base
	}
	for n := 2; ; n++ {
		suffix := strconv.Itoa(n)
		stem := base
		if len(stem)+len(suffix) > nickMaxLen {
			stem = stem[:nickMaxLen-len(suffix)]
		}
		cand := stem + suffix
		if _, ok := taken[foldNick(cand)]; !ok && validNick(cand) {
			return cand
		}
	}
}
