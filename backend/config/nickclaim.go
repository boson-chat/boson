package config

import (
	"bytes"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"strconv"
	"strings"

	"github.com/boson-chat/boson/backend/internal/configfile"
	"gopkg.in/yaml.v3"
)

// The api's part of the stack config file (BOSON_CONFIG, see
// internal/configfile): the `nick_claim:` section. A key set in the file
// wins over the env value; an absent key falls back to env, then the
// built-in default. Removing a key resets it.
//
//	nick_claim:
//	  enabled: false                 # NICK_CLAIM_ENABLED (default false)
//	  email_domain: example.com      # NICK_CLAIM_EMAIL_DOMAIN; addresses are reg+<uid>-<token>@domain
//	  rate_limit_per_hour: 5         # NICK_CLAIM_RATE_LIMIT_PER_HOUR
//	  inbound:
//	    protocol: pop3               # only pop3
//	    host: pop3.example.com       # NICK_CLAIM_POP3_HOST (PURELYMAIL_POP3_HOST)
//	    port: 995                    # NICK_CLAIM_POP3_PORT (PURELYMAIL_POP3_PORT)
//	    tls: true                    # NICK_CLAIM_POP3_TLS (PURELYMAIL_POP3_TLS)
//	    user: reg@example.com        # NICK_CLAIM_POP3_USER (PURELYMAIL_POP3_USER)
//
// The inbound mailbox must be dedicated to this: the worker deletes every
// message it can't match to a claim.
//
// The password never goes in the file: NICK_CLAIM_POP3_PASSWORD
// (PURELYMAIL_POP3_PASSWORD still accepted).

// Section and keys of the file.
const (
	NickClaimSection = "nick_claim"

	ProtocolPOP3 = "pop3"

	// legacyEmailDomain is the old built-in NICK_CLAIM_EMAIL_DOMAIN
	// default, kept for installs still configured through PURELYMAIL_*.
	legacyEmailDomain = "boson.chat"
	defaultPOP3Port   = 995
	defaultRateLimit  = 5
)

// NickClaimInbound is the mailbox the reg+…@domain addresses land in.
type NickClaimInbound struct {
	Protocol string
	Host     string
	Port     int
	TLS      bool
	User     string
	// Password comes from the env only.
	Password string
}

// NickClaimSettings are the effective nick-claim settings.
type NickClaimSettings struct {
	Enabled          bool
	EmailDomain      string
	RateLimitPerHour int
	Inbound          NickClaimInbound
	// Unknown lists keys of nick_claim this version doesn't know (logged).
	Unknown []string
}

// NickClaimFromEnv resolves the settings from env values and defaults
// (no file). NICK_CLAIM_POP3_* win over PURELYMAIL_POP3_*.
func NickClaimFromEnv(a AppConfig) NickClaimSettings {
	in := NickClaimInbound{
		Protocol: ProtocolPOP3,
		Host:     firstNonEmpty(a.NickClaimPOP3Host, a.PurelyMailPOP3Host),
		Port:     a.NickClaimPOP3Port,
		TLS:      a.PurelyMailPOP3TLS,
		User:     firstNonEmpty(a.NickClaimPOP3User, a.PurelyMailPOP3User),
		Password: firstNonEmpty(a.NickClaimPOP3Password, a.PurelyMailPOP3Password),
	}
	if in.Port == 0 {
		in.Port = a.PurelyMailPOP3Port
	}
	if in.Port == 0 {
		in.Port = defaultPOP3Port
	}
	if v, err := strconv.ParseBool(strings.TrimSpace(a.NickClaimPOP3TLS)); err == nil {
		in.TLS = v
	}
	domain := strings.TrimSpace(a.NickClaimEmailDomain)
	if domain == "" && a.PurelyMailPOP3Host != "" {
		domain = legacyEmailDomain
	}
	rate := a.NickClaimRateLimitPerHour
	if rate <= 0 {
		rate = defaultRateLimit
	}
	return NickClaimSettings{
		Enabled:          a.NickClaimEnabled,
		EmailDomain:      domain,
		RateLimitPerHour: rate,
		Inbound:          in,
	}
}

// Validate checks settings that came from env only. It is the same rule the
// file applies: enabling needs an email domain and an inbound host.
func (s NickClaimSettings) Validate() error {
	if !s.Enabled {
		return nil
	}
	var missing []string
	if s.EmailDomain == "" {
		missing = append(missing, "email_domain (NICK_CLAIM_EMAIL_DOMAIN)")
	}
	if s.Inbound.Host == "" {
		missing = append(missing, "inbound.host (NICK_CLAIM_POP3_HOST)")
	}
	if len(missing) > 0 {
		return errors.New("nick_claim is enabled but " + strings.Join(missing, " and ") + " is not set")
	}
	return nil
}

// LoadNickClaimFile decodes and validates the nick_claim section over base
// (the env settings). Errors carry the line and column of the value.
func LoadNickClaimFile(doc *configfile.Document, base NickClaimSettings) (NickClaimSettings, error) {
	out := base
	out.Unknown = nil
	sec, err := doc.Section(NickClaimSection)
	if err != nil {
		return out, err
	}
	in, err := sec.Sub("inbound")
	if err != nil {
		return out, err
	}
	out.Unknown = append(sec.Unknown("enabled", "email_domain", "rate_limit_per_hour", "inbound"),
		in.Unknown("protocol", "host", "port", "tls", "user", "password")...)
	if in.Has("password") {
		return out, in.Errorf("password", "doesn't belong in the config file; set NICK_CLAIM_POP3_PASSWORD in .env")
	}

	if v, err := sec.Bool("enabled"); err != nil {
		return out, err
	} else if v != nil {
		out.Enabled = *v
	}
	if v, err := sec.String("email_domain"); err != nil {
		return out, err
	} else if v != nil {
		d := strings.TrimSpace(*v)
		if d == "" || strings.ContainsAny(d, "@ /") || (!strings.Contains(d, ".") && d != "localhost") {
			return out, sec.Errorf("email_domain", "must be a domain such as example.com, got %q", *v)
		}
		out.EmailDomain = d
	}
	if v, err := sec.Int("rate_limit_per_hour"); err != nil {
		return out, err
	} else if v != nil {
		if *v < 1 || *v > 10000 {
			return out, sec.Errorf("rate_limit_per_hour", "must be between 1 and 10000, got %d", *v)
		}
		out.RateLimitPerHour = *v
	}
	if v, err := in.String("protocol"); err != nil {
		return out, err
	} else if v != nil {
		p := strings.ToLower(strings.TrimSpace(*v))
		if p != ProtocolPOP3 {
			return out, in.Errorf("protocol", "must be pop3 (the only protocol supported), got %q", *v)
		}
		out.Inbound.Protocol = p
	}
	if v, err := in.String("host"); err != nil {
		return out, err
	} else if v != nil {
		out.Inbound.Host = strings.TrimSpace(*v)
	}
	if v, err := in.Int("port"); err != nil {
		return out, err
	} else if v != nil {
		if *v < 1 || *v > 65535 {
			return out, in.Errorf("port", "must be between 1 and 65535, got %d", *v)
		}
		out.Inbound.Port = *v
	}
	if v, err := in.Bool("tls"); err != nil {
		return out, err
	} else if v != nil {
		out.Inbound.TLS = *v
	}
	if v, err := in.String("user"); err != nil {
		return out, err
	} else if v != nil {
		out.Inbound.User = strings.TrimSpace(*v)
	}

	if out.Enabled {
		key, at := "enabled", sec
		if !sec.Has("enabled") {
			at = nil // turned on by NICK_CLAIM_ENABLED
		}
		switch {
		case out.EmailDomain == "":
			if at == nil {
				return out, &configfile.Error{Msg: "nick_claim: enabled (NICK_CLAIM_ENABLED) but email_domain is not set"}
			}
			return out, at.Errorf(key, "is true but nick_claim.email_domain is not set")
		case out.Inbound.Host == "":
			if at == nil {
				return out, &configfile.Error{Msg: "nick_claim: enabled (NICK_CLAIM_ENABLED) but inbound.host is not set"}
			}
			return out, at.Errorf(key, "is true but nick_claim.inbound.host is not set")
		}
	}
	return out, nil
}

// ExportNickClaim prints the nick_claim section built from the env (for
// `export-config`). enabled is true when NICK_CLAIM_ENABLED is set or an
// inbound POP3 host is configured, so an install that ran the worker
// through PURELYMAIL_POP3_* keeps it on once it moves to the file. The
// password is never printed.
func ExportNickClaim(a AppConfig) ([]byte, error) {
	return encodeNickClaim(exportBase(a))
}

// ExportNickClaimWithFile is ExportNickClaim with the nick_claim section
// of the config file at path (when it exists) applied on top, so a
// re-run after the move prints what is in effect. An invalid file is an
// error.
func ExportNickClaimWithFile(a AppConfig, path string) ([]byte, error) {
	s := exportBase(a)
	if path != "" {
		data, err := os.ReadFile(path)
		switch {
		case errors.Is(err, fs.ErrNotExist):
		case err != nil:
			return nil, err
		default:
			doc, err := configfile.Parse(data)
			if err != nil {
				return nil, fmt.Errorf("%s: %w", path, err)
			}
			if s, err = LoadNickClaimFile(doc, s); err != nil {
				return nil, fmt.Errorf("%s: %w", path, err)
			}
		}
	}
	return encodeNickClaim(s)
}

func exportBase(a AppConfig) NickClaimSettings {
	s := NickClaimFromEnv(a)
	s.Enabled = s.Enabled || s.Inbound.Host != ""
	return s
}

func encodeNickClaim(s NickClaimSettings) ([]byte, error) {
	// Empty strings are left out: an absent key means "env / default",
	// while an empty value would be rejected (email_domain) or override.
	var inbound []any
	inbound = append(inbound, "protocol", ProtocolPOP3)
	inbound = appendNonEmpty(inbound, "host", s.Inbound.Host)
	inbound = append(inbound, "port", s.Inbound.Port, "tls", s.Inbound.TLS)
	inbound = appendNonEmpty(inbound, "user", s.Inbound.User)
	sec := []any{"enabled", s.Enabled}
	sec = appendNonEmpty(sec, "email_domain", s.EmailDomain)
	sec = append(sec, "rate_limit_per_hour", s.RateLimitPerHour, "inbound", mapping(inbound...))
	root := mapping(NickClaimSection, mapping(sec...))
	root.Content[0].HeadComment = "Exported by `boson export-config` (the api) from the env and BOSON_CONFIG.\n" +
		"Merge into config/boson.yaml; NICK_CLAIM_POP3_PASSWORD stays in .env.\n" +
		"The inbound mailbox must be dedicated to nick claims (catch-all for reg+<uid>-<token>@email_domain):\n" +
		"the worker deletes every message it can't match to a claim."
	var buf bytes.Buffer
	enc := yaml.NewEncoder(&buf)
	enc.SetIndent(2)
	if err := enc.Encode(&yaml.Node{Kind: yaml.DocumentNode, Content: []*yaml.Node{root}}); err != nil {
		return nil, err
	}
	if err := enc.Close(); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

// mapping builds a YAML mapping node from alternating keys and values.
func mapping(kv ...any) *yaml.Node {
	m := &yaml.Node{Kind: yaml.MappingNode, Tag: "!!map"}
	for i := 0; i+1 < len(kv); i += 2 {
		k := &yaml.Node{Kind: yaml.ScalarNode, Tag: "!!str", Value: fmt.Sprint(kv[i])}
		var v *yaml.Node
		switch x := kv[i+1].(type) {
		case *yaml.Node:
			v = x
		default:
			v = &yaml.Node{}
			if err := v.Encode(x); err != nil {
				v = &yaml.Node{Kind: yaml.ScalarNode, Value: fmt.Sprint(x)}
			}
		}
		m.Content = append(m.Content, k, v)
	}
	return m
}

func appendNonEmpty(kv []any, key, v string) []any {
	if v == "" {
		return kv
	}
	return append(kv, key, v)
}

func firstNonEmpty(vals ...string) string {
	for _, v := range vals {
		if v = strings.TrimSpace(v); v != "" {
			return v
		}
	}
	return ""
}
