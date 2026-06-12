package nickclaim_test

import (
	"testing"

	"github.com/boson-chat/boson/backend/internal/services/nickclaim"

	"github.com/stretchr/testify/assert"
)

func TestExtractCode_AnopeBody(t *testing.T) {
	// Canonical Anope ns_register.cpp template. The CONFIRM verb +
	// code is always present in the body, sometimes surrounded by
	// instructions and a footer.
	body := `Hi Nyan,

Thank you for registering on irc.boson.chat. To complete the
registration please run:

    /msg NickServ CONFIRM AbCd1234

If you didn't request this, you can safely ignore this message.
`
	code, ok := nickclaim.ExtractCode(body)
	assert.True(t, ok)
	assert.Equal(t, "AbCd1234", code)
}

func TestExtractCode_AthemeBody(t *testing.T) {
	// Atheme verify.c template. VERIFY REGISTER + account + key.
	// Capture only the trailing key (the account is the middle arg).
	body := `In order to complete your registration, you must send the following
command to NickServ:

/msg NickServ VERIFY REGISTER Nyan ab12cd34ef

Thank you for using services on irc.libera.chat.
`
	code, ok := nickclaim.ExtractCode(body)
	assert.True(t, ok)
	assert.Equal(t, "ab12cd34ef", code)
}

func TestExtractCode_HandlesQuotedPrintableSoftBreaks(t *testing.T) {
	// Real mail bodies get wrapped at column 76 with "=\n" soft
	// breaks. The extractor should strip those before regex match.
	body := "Please run: /msg NickServ CONFIRM " +
		"ABC=\n123DEF"
	code, ok := nickclaim.ExtractCode(body)
	assert.True(t, ok)
	assert.Equal(t, "ABC123DEF", code)
}

func TestExtractCode_GenericFallback(t *testing.T) {
	// Newer / translated NickServ message catalogs may emit a
	// "verification code: XXX" line without the inline /msg form.
	bodies := []string{
		"Your verification code: ABC-123-DEF",
		"Use this passcode: ABC-123-DEF",
		"Verification code:  ABC-123-DEF",
	}
	for _, b := range bodies {
		code, ok := nickclaim.ExtractCode(b)
		assert.True(t, ok, "body: %q", b)
		assert.Equal(t, "ABC-123-DEF", code, "body: %q", b)
	}
}

func TestExtractCode_NoMatchReturnsEmpty(t *testing.T) {
	bodies := []string{
		"",
		"Just a friendly newsletter unrelated to NickServ.",
		"The code is going to arrive soon.", // word "code" but no colon
	}
	for _, b := range bodies {
		code, ok := nickclaim.ExtractCode(b)
		assert.False(t, ok, "body: %q", b)
		assert.Empty(t, code)
	}
}

func TestExtractCode_AnopeWinsOverGenericWhenBothPresent(t *testing.T) {
	// If a body has both phrasings (extremely unlikely but covered
	// for ordering correctness), the specific Anope CONFIRM regex
	// fires first.
	body := `Verification code: WRONG-FALLBACK
Please run: /msg NickServ CONFIRM REAL-CODE-1234
`
	code, ok := nickclaim.ExtractCode(body)
	assert.True(t, ok)
	assert.Equal(t, "REAL-CODE-1234", code)
}

func TestExtractAccountName_Atheme(t *testing.T) {
	body := `To verify your account, issue this:
/msg NickServ VERIFY REGISTER Nyan abcd-1234
`
	nick, ok := nickclaim.ExtractAccountName("", body)
	assert.True(t, ok)
	assert.Equal(t, "Nyan", nick)
}

func TestExtractAccountName_Ergo(t *testing.T) {
	body := `Account: Nyan
Verification code: deadbeef
To verify your account, issue the following command:
/msg NickServ VERIFY Nyan deadbeef
`
	nick, ok := nickclaim.ExtractAccountName("", body)
	assert.True(t, ok)
	assert.Equal(t, "Nyan", nick)
}

func TestExtractAccountName_AnopeBody(t *testing.T) {
	// Verbatim Anope 2.0 template — `mail::registration_message`
	// in data/example.conf. Multiple translations exist; the
	// English default is "You have requested to register the
	// nickname X on Y."
	body := `Hi,

You have requested to register the nickname Nyan on boson-chat.
Please type " /msg NickServ CONFIRM abc-123 " to complete registration.
`
	nick, ok := nickclaim.ExtractAccountName("", body)
	assert.True(t, ok)
	assert.Equal(t, "Nyan", nick)
}

func TestExtractAccountName_AnopeSubjectOnly(t *testing.T) {
	// Body is HTML-only or missing the prose; subject still
	// carries the nick via `mail::registration_subject = "Nickname
	// registration for %n"`.
	subject := "Nickname registration for Nyan"
	body := `Please type " /msg NickServ CONFIRM abc-123 " to complete registration.`
	nick, ok := nickclaim.ExtractAccountName(subject, body)
	assert.True(t, ok)
	assert.Equal(t, "Nyan", nick)
}

func TestExtractAccountName_NoMatch(t *testing.T) {
	body := `Welcome to the network!
Your verification code is: nope-1234
`
	nick, ok := nickclaim.ExtractAccountName("Some unrelated subject", body)
	assert.False(t, ok)
	assert.Empty(t, nick)
}
