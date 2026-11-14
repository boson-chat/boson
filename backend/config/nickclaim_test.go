package config

import (
	"os"
	"strings"
	"testing"

	"github.com/boson-chat/boson/backend/internal/configfile"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func legacyEnv() AppConfig {
	return AppConfig{
		NickClaimRateLimitPerHour: 5,
		PurelyMailPOP3Host:        "mail.purelymail.com",
		PurelyMailPOP3Port:        995,
		PurelyMailPOP3User:        "reg@boson.chat",
		PurelyMailPOP3Password:    "legacy-secret",
		PurelyMailPOP3TLS:         true,
	}
}

func TestNickClaimFromEnv_DefaultsAreOff(t *testing.T) {
	s := NickClaimFromEnv(AppConfig{PurelyMailPOP3Port: 995, PurelyMailPOP3TLS: true})
	assert.False(t, s.Enabled)
	assert.Equal(t, "", s.EmailDomain)
	assert.Equal(t, 5, s.RateLimitPerHour)
	assert.Equal(t, NickClaimInbound{Protocol: "pop3", Port: 995, TLS: true}, s.Inbound)
	assert.NoError(t, s.Validate())
}

func TestNickClaimFromEnv_LegacyFallbacksDoNotEnable(t *testing.T) {
	s := NickClaimFromEnv(legacyEnv())
	assert.False(t, s.Enabled, "PURELYMAIL_POP3_* alone must not turn nick claims on")
	assert.Equal(t, "boson.chat", s.EmailDomain, "legacy installs keep the old default domain")
	assert.Equal(t, "mail.purelymail.com", s.Inbound.Host)
	assert.Equal(t, "reg@boson.chat", s.Inbound.User)
	assert.Equal(t, "legacy-secret", s.Inbound.Password)
	assert.True(t, s.Inbound.TLS)
}

func TestNickClaimFromEnv_NewNamesWin(t *testing.T) {
	a := legacyEnv()
	a.NickClaimEnabled = true
	a.NickClaimEmailDomain = "example.com"
	a.NickClaimPOP3Host = "pop3.example.com"
	a.NickClaimPOP3Port = 1110
	a.NickClaimPOP3User = "reg@example.com"
	a.NickClaimPOP3Password = "new-secret"
	a.NickClaimPOP3TLS = "false"
	s := NickClaimFromEnv(a)
	assert.True(t, s.Enabled)
	assert.Equal(t, "example.com", s.EmailDomain)
	assert.Equal(t, NickClaimInbound{Protocol: "pop3", Host: "pop3.example.com", Port: 1110, TLS: false,
		User: "reg@example.com", Password: "new-secret"}, s.Inbound)
	assert.NoError(t, s.Validate())
}

func TestNickClaimSettings_ValidateEnabledNeedsDomainAndHost(t *testing.T) {
	s := NickClaimFromEnv(AppConfig{NickClaimEnabled: true})
	err := s.Validate()
	require.Error(t, err)
	assert.Contains(t, err.Error(), "email_domain")
	assert.Contains(t, err.Error(), "inbound.host")
}

func TestLoadConfigOrPanic_NickClaimEnv(t *testing.T) {
	t.Setenv("NICK_CLAIM_ENABLED", "true")
	t.Setenv("NICK_CLAIM_POP3_TLS", "false")
	t.Setenv("PURELYMAIL_POP3_HOST", "legacy.example.com")
	t.Setenv("INTERNAL_API_TOKEN", "tok")
	t.Setenv("BOSON_CONFIG", "/config/boson.yaml")
	cfg := LoadConfigOrPanic()
	s := NickClaimFromEnv(cfg.AppConfig)
	assert.True(t, s.Enabled)
	assert.False(t, s.Inbound.TLS)
	assert.Equal(t, "legacy.example.com", s.Inbound.Host)
	assert.Equal(t, ":3001", cfg.InternalConfig.ListenAddr())
	assert.Equal(t, "tok", cfg.InternalConfig.SharedToken(), "INTERNAL_API_TOKEN still accepted")
	assert.Equal(t, "/config/boson.yaml", cfg.StackConfig.Path)
}

func parseNickClaim(t *testing.T, src string, base NickClaimSettings) (NickClaimSettings, error) {
	t.Helper()
	doc, err := configfile.Parse([]byte(src))
	require.NoError(t, err)
	return LoadNickClaimFile(doc, base)
}

func TestLoadNickClaimFile_FileBeatsEnv(t *testing.T) {
	base := NickClaimFromEnv(legacyEnv())
	s, err := parseNickClaim(t, `version: 1
nick_claim:
  enabled: true
  email_domain: example.com
  rate_limit_per_hour: 7
  inbound:
    protocol: pop3
    host: pop3.example.com
    port: 1995
    tls: false
    user: reg@example.com
`, base)
	require.NoError(t, err)
	assert.True(t, s.Enabled)
	assert.Equal(t, "example.com", s.EmailDomain)
	assert.Equal(t, 7, s.RateLimitPerHour)
	assert.Equal(t, NickClaimInbound{Protocol: "pop3", Host: "pop3.example.com", Port: 1995, TLS: false,
		User: "reg@example.com", Password: "legacy-secret"}, s.Inbound, "password stays from env")
}

func TestLoadNickClaimFile_AbsentKeysFallBackToEnv(t *testing.T) {
	base := NickClaimFromEnv(legacyEnv())
	s, err := parseNickClaim(t, "version: 1\nnick_claim:\n  enabled: true\n", base)
	require.NoError(t, err)
	assert.True(t, s.Enabled)
	assert.Equal(t, base.Inbound, s.Inbound)
	assert.Equal(t, "boson.chat", s.EmailDomain)

	// No section at all: env as is.
	s, err = parseNickClaim(t, "version: 1\nauth: {registration: open}\n", base)
	require.NoError(t, err)
	assert.Equal(t, base.Enabled, s.Enabled)
	assert.Equal(t, base.Inbound, s.Inbound)
}

func TestLoadNickClaimFile_FileCanDisableEnvEnabled(t *testing.T) {
	a := legacyEnv()
	a.NickClaimEnabled = true
	s, err := parseNickClaim(t, "nick_claim:\n  enabled: false\n", NickClaimFromEnv(a))
	require.NoError(t, err)
	assert.False(t, s.Enabled)
}

func TestLoadNickClaimFile_Errors(t *testing.T) {
	cases := []struct {
		name, src, want string
		line            int
	}{
		{"enabled not bool", "nick_claim:\n  enabled: maybe\n", "true or false", 2},
		{"bad domain", "nick_claim:\n  email_domain: \"reg@example.com\"\n", "must be a domain", 2},
		{"empty domain", "nick_claim:\n  email_domain: \"\"\n", "must be a domain", 2},
		{"rate", "nick_claim:\n  rate_limit_per_hour: 0\n", "between 1 and 10000", 2},
		{"protocol", "nick_claim:\n  inbound:\n    protocol: imap\n", "must be pop3", 3},
		{"port", "nick_claim:\n  inbound:\n    port: 70000\n", "between 1 and 65535", 3},
		{"tls", "nick_claim:\n  inbound:\n    tls: sometimes\n", "true or false", 3},
		{"password in file", "nick_claim:\n  inbound:\n    password: hunter2\n", "NICK_CLAIM_POP3_PASSWORD", 3},
		{"inbound not mapping", "nick_claim:\n  inbound: pop3\n", "must be a mapping", 2},
		{"enabled without host", "nick_claim:\n  enabled: true\n  email_domain: example.com\n", "inbound.host is not set", 2},
		{"enabled without domain", "nick_claim:\n  enabled: true\n  inbound: {host: h.example.com}\n", "email_domain is not set", 2},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			_, err := parseNickClaim(t, c.src, NickClaimFromEnv(AppConfig{PurelyMailPOP3Port: 995}))
			require.Error(t, err)
			assert.Contains(t, err.Error(), c.want)
			e, ok := configfile.AsError(err)
			require.True(t, ok, "positioned error: %v", err)
			assert.Equal(t, c.line, e.Line, err.Error())
			assert.NotContains(t, err.Error(), "hunter2")
		})
	}
}

func TestLoadNickClaimFile_EnvEnabledWithoutHost(t *testing.T) {
	_, err := parseNickClaim(t, "nick_claim:\n  email_domain: example.com\n",
		NickClaimFromEnv(AppConfig{NickClaimEnabled: true}))
	require.Error(t, err)
	assert.Contains(t, err.Error(), "NICK_CLAIM_ENABLED")
}

func TestLoadNickClaimFile_UnknownKeys(t *testing.T) {
	s, err := parseNickClaim(t, "nick_claim:\n  enabeld: true\n  inbound:\n    hots: x\n", NickClaimSettings{})
	require.NoError(t, err)
	assert.Equal(t, []string{"nick_claim.enabeld", "nick_claim.inbound.hots"}, s.Unknown)
}

func TestExportNickClaim_LegacyInstallStaysOn(t *testing.T) {
	out, err := ExportNickClaim(legacyEnv())
	require.NoError(t, err)
	text := string(out)
	assert.NotContains(t, text, "legacy-secret", "the password is never exported")
	assert.Contains(t, text, "enabled: true")
	assert.True(t, strings.HasPrefix(text, "# Exported by"))

	// Round trip: the export, loaded over an empty env (the password aside),
	// gives the same settings.
	s, err := parseNickClaim(t, "version: 1\n"+text, NickClaimSettings{Inbound: NickClaimInbound{Password: "legacy-secret"}})
	require.NoError(t, err)
	assert.True(t, s.Enabled)
	assert.Equal(t, "boson.chat", s.EmailDomain)
	assert.Equal(t, 5, s.RateLimitPerHour)
	assert.Equal(t, NickClaimInbound{Protocol: "pop3", Host: "mail.purelymail.com", Port: 995, TLS: true,
		User: "reg@boson.chat", Password: "legacy-secret"}, s.Inbound)
}

func TestExportNickClaim_NoHostIsOff(t *testing.T) {
	out, err := ExportNickClaim(AppConfig{PurelyMailPOP3Port: 995, PurelyMailPOP3TLS: true, NickClaimRateLimitPerHour: 5})
	require.NoError(t, err)
	assert.Contains(t, string(out), "enabled: false")
	assert.NotContains(t, string(out), "  email_domain:", "empty values are left out")
	s, err := parseNickClaim(t, string(out), NickClaimSettings{})
	require.NoError(t, err, "the export is a valid file section")
	assert.False(t, s.Enabled)
}

func TestExportNickClaim_ExplicitEnable(t *testing.T) {
	a := AppConfig{NickClaimEnabled: true, NickClaimEmailDomain: "example.com", NickClaimPOP3Host: "h.example.com", NickClaimRateLimitPerHour: 3}
	out, err := ExportNickClaim(a)
	require.NoError(t, err)
	assert.Contains(t, string(out), "enabled: true")
	assert.Contains(t, string(out), "email_domain: example.com")
	assert.Contains(t, string(out), "rate_limit_per_hour: 3")
}

func TestInternalConfig(t *testing.T) {
	assert.Equal(t, ":3001", InternalConfig{Port: 3001}.ListenAddr())
	assert.Equal(t, "127.0.0.1:13001", InternalConfig{Port: 3001, Addr: "127.0.0.1:13001"}.ListenAddr())
	assert.Equal(t, "", InternalConfig{Port: 3001, Addr: "off"}.ListenAddr())
	assert.Equal(t, "", InternalConfig{}.ListenAddr())
	assert.Equal(t, "new", InternalConfig{Token: "new", APIToken: "old"}.SharedToken())
	assert.Equal(t, "old", InternalConfig{APIToken: "old"}.SharedToken())
}

func TestLoadConfigOrPanic_InternalPort(t *testing.T) {
	t.Setenv("INTERNAL_PORT", "4001")
	t.Setenv("INTERNAL_TOKEN", "t1")
	cfg := LoadConfigOrPanic()
	assert.Equal(t, ":4001", cfg.InternalConfig.ListenAddr())
	assert.Equal(t, "t1", cfg.InternalConfig.SharedToken())
}

func TestExportNickClaimWithFile(t *testing.T) {
	dir := t.TempDir()
	path := dir + "/boson.yaml"

	// Missing file: env only.
	out, err := ExportNickClaimWithFile(legacyEnv(), path)
	require.NoError(t, err)
	assert.Contains(t, string(out), "enabled: true")
	assert.Contains(t, string(out), "must be dedicated")

	// The file wins: turned off there, and another host.
	require.NoError(t, os.WriteFile(path, []byte("version: 1\nnick_claim:\n  enabled: false\n  inbound: {host: pop3.example.com, tls: false, port: 1110}\n"), 0o644))
	out, err = ExportNickClaimWithFile(legacyEnv(), path)
	require.NoError(t, err)
	text := string(out)
	assert.Contains(t, text, "enabled: false")
	assert.Contains(t, text, "host: pop3.example.com")
	assert.Contains(t, text, "tls: false")
	assert.Contains(t, text, "port: 1110")
	assert.NotContains(t, text, "legacy-secret")

	// NICK_CLAIM_ENABLED without a file key is reflected.
	a := AppConfig{NickClaimEnabled: true, NickClaimEmailDomain: "example.com", NickClaimRateLimitPerHour: 5}
	require.NoError(t, os.WriteFile(path, []byte("nick_claim:\n  inbound: {host: h.example.com}\n"), 0o644))
	out, err = ExportNickClaimWithFile(a, path)
	require.NoError(t, err)
	assert.Contains(t, string(out), "enabled: true")

	// Broken file: error with position.
	require.NoError(t, os.WriteFile(path, []byte("nick_claim:\n  enabled: maybe\n"), 0o644))
	_, err = ExportNickClaimWithFile(legacyEnv(), path)
	require.Error(t, err)
	assert.Contains(t, err.Error(), "line 2")
}
