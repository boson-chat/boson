package nickclaim_test

import (
	"testing"

	"github.com/boson-chat/boson/backend/internal/services/nickclaim"

	"github.com/stretchr/testify/assert"
)

func TestParseRecipient(t *testing.T) {
	cases := []struct {
		name  string
		input string
		want  string
		ok    bool
	}{
		{
			name:  "bare address",
			input: "reg-550e8400e29b41d4a716446655440000-abc12345@boson.chat",
			want:  "abc12345",
			ok:    true,
		},
		{
			name:  "display-name + brackets (RFC 5322 form mail headers use)",
			input: "Some Display <reg-550e8400e29b41d4a716446655440000-abc12345@boson.chat>",
			want:  "abc12345",
			ok:    true,
		},
		{
			name:  "uppercase domain (case-folded by parser)",
			input: "REG-550E8400E29B41D4A716446655440000-ABC12345@BOSON.CHAT",
			want:  "abc12345",
			ok:    true,
		},
		{
			name:  "leading whitespace",
			input: "   reg-550e8400e29b41d4a716446655440000-abc12345@boson.chat",
			want:  "abc12345",
			ok:    true,
		},
		{
			name:  "multiple addresses — takes the first",
			input: "reg-550e8400e29b41d4a716446655440000-abc12345@boson.chat, other@x.com",
			want:  "abc12345",
			ok:    true,
		},
		// Non-matches
		{name: "wrong prefix",         input: "support-abc12345@boson.chat", want: "", ok: false},
		{name: "missing short_token",  input: "reg-550e8400e29b41d4a716446655440000@boson.chat", want: "", ok: false},
		{name: "short_token too short", input: "reg-550e8400e29b41d4a716446655440000-abc@boson.chat", want: "", ok: false},
		{name: "short_token has invalid chars", input: "reg-550e8400e29b41d4a716446655440000-ABC!1234@boson.chat", want: "", ok: false},
		{name: "userid wrong length",  input: "reg-too-short-abc12345@boson.chat", want: "", ok: false},
		{name: "empty",                input: "", want: "", ok: false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, ok := nickclaim.ParseRecipient(tc.input)
			assert.Equal(t, tc.ok, ok)
			assert.Equal(t, tc.want, got)
		})
	}
}

func TestEmailAddressFor(t *testing.T) {
	got := nickclaim.EmailAddressFor("550e8400e29b41d4a716446655440000", "abc12345", "boson.chat")
	assert.Equal(t, "reg-550e8400e29b41d4a716446655440000-abc12345@boson.chat", got)

	// Round-trips through ParseRecipient.
	token, ok := nickclaim.ParseRecipient(got)
	assert.True(t, ok)
	assert.Equal(t, "abc12345", token)
}
