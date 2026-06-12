package nickclaim

import (
	"regexp"
	"strings"
)

// ExtractCode pulls the confirmation code out of a NickServ-emailed
// activation body. Returns the code + true on success; empty + false
// when no recognisable pattern matched.
//
// Patterns ordered by specificity. The first hit wins.
//
//   Anope     "/msg NickServ CONFIRM <code>"
//             (ns_register.cpp template body)
//   Atheme    "/msg NickServ VERIFY REGISTER <acct> <key>"
//             (verify.c template body)
//   Generic   line "code: <token>" / "passcode: <token>" /
//             "verification code: <token>" — fallback for non-
//             canonical phrasings or new services packages.
//
// Returns the FIRST non-empty match. Bodies are sometimes wrapped
// at column 80 with the verb on one line and the args on the next —
// we tolerate that by allowing whitespace (including newlines) in
// the inline-command form.
func ExtractCode(body string) (string, bool) {
	body = stripQuotedPrintableArtifacts(body)

	if m := rxAnopeConfirm.FindStringSubmatch(body); m != nil {
		return strings.TrimSpace(m[1]), true
	}
	if m := rxAthemeVerify.FindStringSubmatch(body); m != nil {
		return strings.TrimSpace(m[1]), true
	}
	if m := rxGenericCode.FindStringSubmatch(body); m != nil {
		return strings.TrimSpace(m[1]), true
	}
	return "", false
}

var (
	// Anope phrasing. CONFIRM verb, single code arg. Allow a
	// newline + indentation between the verb and the code because
	// Anope's mail templates wrap at column 76.
	rxAnopeConfirm = regexp.MustCompile(`(?i)/msg\s+NickServ\s+CONFIRM\s+([A-Za-z0-9_\-:.]+)`)

	// Atheme phrasing. VERIFY REGISTER <acct> <key>. The middle
	// arg is the account name; capture only the trailing key.
	rxAthemeVerify = regexp.MustCompile(`(?i)/msg\s+NickServ\s+VERIFY\s+REGISTER\s+\S+\s+([A-Za-z0-9_\-:.]+)`)

	// Generic last-resort. "passcode: ABC123", "code: foo-bar".
	// Strict on the colon so prose like "code is going" doesn't
	// match. The "verification" prefix variant catches NickServ
	// emails from newer/translated message catalogs.
	rxGenericCode = regexp.MustCompile(`(?i)(?:verification\s+)?(?:passcode|code)[:\s]+\s*([A-Za-z0-9_\-:.]{6,64})`)

	// Account-name extractors — used when the recipient address has
	// been stripped of its `-<userid>-<short>` discriminator (e.g.
	// PurelyMail catch-alls that collapse all `*@boson.chat` to a
	// single mailbox), so we can still route the captured code to
	// the right pending claim via the account_nick column.
	//
	// Patterns:
	//   Atheme   "/msg NickServ VERIFY REGISTER <acct> <key>"  (verify.c)
	//   Ergo     "/MSG NickServ VERIFY <acct> <code>"  (accounts.go)
	//   Anope    "You have requested to register the nickname <nick>
	//             on <Network>" — prose template from
	//             `mail::registration_message` in example.conf, also
	//             "Nickname registration for <nick>" in the Subject
	//             from `mail::registration_subject`. The CONFIRM line
	//             contains only the code, not the nick, so we have to
	//             read the surrounding prose. (See
	//             modules/commands/ns_register.cpp::SendRegmail.)
	rxAthemeNick = regexp.MustCompile(`(?i)/msg\s+NickServ\s+VERIFY\s+REGISTER\s+(\S+)\s+\S+`)
	rxErgoNick   = regexp.MustCompile(`(?i)/msg\s+NickServ\s+VERIFY\s+(\S+)\s+[A-Za-z0-9_\-:.]+`)
	rxAnopeBody  = regexp.MustCompile(`(?i)register(?:ed)?\s+the\s+nickname\s+([A-Za-z\x60][A-Za-z0-9_\-\[\]\\^{|}\x60]{0,31})`)
	// Anope's subject template is configurable but defaults to
	// "Nickname registration for %n". Match permissively: any text
	// ending in "for <nick>" coming after "registration".
	rxAnopeSubject = regexp.MustCompile(`(?i)registration\s+for\s+([A-Za-z\x60][A-Za-z0-9_\-\[\]\\^{|}\x60]{0,31})`)
)

// ExtractAccountName pulls the NickServ account name out of an
// activation email's body and/or subject. Pass both — Anope's
// subject template carries the nick even when the body wraps it
// inside translated prose. Returns the name + true on hit, empty
// + false otherwise.
//
// Used by the POP3 worker to route a captured code to the right
// pending claim when the recipient address has been collapsed by
// a catch-all to something like `reg@<domain>` (no short_token
// in the local part). All three services are covered:
//   - Atheme:  body "/msg NickServ VERIFY REGISTER <nick> ..."
//   - Ergo:    body "/MSG NickServ VERIFY <nick> ..."
//   - Anope:   subject "Nickname registration for <nick>" OR
//              body "register(ed) the nickname <nick>"
func ExtractAccountName(subject, body string) (string, bool) {
	body = stripQuotedPrintableArtifacts(body)
	// Specific verb patterns first — they're constrained enough that
	// they only fire on real activation bodies, so a body-and-subject
	// false-positive race can't pick the wrong nick.
	if m := rxAthemeNick.FindStringSubmatch(body); m != nil {
		return strings.TrimSpace(m[1]), true
	}
	if m := rxErgoNick.FindStringSubmatch(body); m != nil {
		return strings.TrimSpace(m[1]), true
	}
	if m := rxAnopeBody.FindStringSubmatch(body); m != nil {
		return strings.TrimSpace(m[1]), true
	}
	// Anope subject ("Nickname registration for <nick>") is the
	// last-ditch fallback — the body might have been multipart
	// HTML-only or translated, but the subject template `%n`
	// passes through unmangled.
	if m := rxAnopeSubject.FindStringSubmatch(subject); m != nil {
		return strings.TrimSpace(m[1]), true
	}
	return "", false
}

// stripQuotedPrintableArtifacts removes the soft-line-break tokens
// quoted-printable email bodies insert at column 76. Without this,
// codes that happen to straddle a wrap point would be parsed with
// `=\n` in the middle.
//
// Real email parsing would use mime/quotedprintable + the message's
// declared encoding; for our purposes the bodies are plaintext
// generated by services packages and use only the `=\n` soft-break
// convention.
func stripQuotedPrintableArtifacts(s string) string {
	s = strings.ReplaceAll(s, "=\r\n", "")
	s = strings.ReplaceAll(s, "=\n", "")
	return s
}
