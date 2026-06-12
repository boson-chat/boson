package nickclaim

import (
	"fmt"
	"regexp"
	"strings"
)

// ParseRecipient extracts the short_token from a `reg+<userid>-<short>@<domain>`
// recipient address (plus-addressing: base mailbox `reg`, subaddress tag
// `<userid>-<short>`). Returns the token + true on a successful match.
//
// We don't validate the userid portion against the database (the
// claim's user_id is already known via short_token lookup); we just
// confirm the shape so a stray non-reg mail doesn't get parsed.
//
// Tolerates:
//   - the bracket-wrapped form some headers use: "Recipient <reg+...>".
//   - uppercase / mixed-case in the address (RFC 5321 local-part is
//     case-sensitive but mail-server catch-all delivery typically
//     case-folds; lowercase the input).
//   - addresses with extra whitespace.
func ParseRecipient(header string) (string, bool) {
	// Pull the bare address out of "Display Name <addr@host>" and
	// strip whitespace. Multiple addresses (separated by ,) take
	// only the first — catch-all delivery puts our address there.
	addr := extractAddress(strings.TrimSpace(header))
	addr = strings.ToLower(addr)

	m := rxRecipient.FindStringSubmatch(addr)
	if m == nil {
		return "", false
	}
	return m[2], true
}

// EmailAddressFor returns the canonical recipient string for a
// claim — the same one ParseRecipient round-trips. Used in tests
// and as documentation.
func EmailAddressFor(userIDHex, shortToken, domain string) string {
	return fmt.Sprintf("reg+%s-%s@%s", userIDHex, shortToken, domain)
}

func extractAddress(s string) string {
	if i := strings.LastIndex(s, "<"); i >= 0 {
		if j := strings.Index(s[i:], ">"); j > 0 {
			return s[i+1 : i+j]
		}
	}
	if i := strings.Index(s, ","); i >= 0 {
		return strings.TrimSpace(s[:i])
	}
	return s
}

// rxRecipient is split into two captures: [1] is the userid hex
// (32 chars after dashes are stripped), [2] is the short_token.
// The userid capture is currently unused but kept for future
// per-user validation / logging.
var rxRecipient = regexp.MustCompile(`^reg\+([a-f0-9]{32})-([a-z0-9]{8})@`)
