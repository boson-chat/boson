package config

import (
	"os"
	"path/filepath"

	"github.com/jinzhu/configor"
)

// Config aggregates every subsystem's tunables. Loaded via
// configor — values come from (in order of precedence):
//   1. Environment variables (matching the `env:"NAME"` tag).
//   2. The local JSON config file (path resolved by
//      configFileSearchPaths below; tolerates missing).
//   3. The `default:"..."` tag.
//
// This matches the convention used across other weeb-vip Go services
// (anime-api, gateway-proxy, etc.) — a versioned `config.dev.json`
// in-repo carries the local defaults so `make run` works out of
// the box, and prod overrides via env vars set by the k8s manifest.
type Config struct {
	AppConfig  AppConfig
	DBConfig   DBConfig
	AuthConfig AuthConfig
}

type AppConfig struct {
	AppName        string `default:"boson"`
	Port           int    `env:"PORT" default:"3000"`
	Env            string `env:"ENV" default:"development"`
	AllowedOrigins string `env:"ALLOWED_ORIGINS" default:"http://localhost:5173"`
	// Local-dev convenience: when true, POST /servers/{id}/verify auto-
	// succeeds without actually issuing any DNS queries. The verify
	// cron does the same. Avoids needing to own (and add a TXT record
	// to) a real public hostname when registering against a localhost
	// IRCd. Production deployments leave this OFF — Helm doesn't set
	// the env var in the prod chart.
	SkipDNSVerify bool `env:"SKIP_DNS_VERIFY" default:"false"`

	// NickClaim subsystem — automated NickServ email-confirmation
	// flow for signed-in users. The emails minted by this feature
	// have shape `reg-<userid>-<short>@<NickClaimEmailDomain>` and
	// the POP3 worker (when configured) reads them out of the
	// catch-all mailbox at PURELYMAIL_POP3_*.
	//
	// Defaults sized for the production deployment at boson.chat;
	// local dev points the POP3 fields at a mailpit container (see
	// backend/config/config.dev.json).
	NickClaimEmailDomain      string `env:"NICK_CLAIM_EMAIL_DOMAIN" default:"boson.chat"`
	NickClaimRateLimitPerHour int    `env:"NICK_CLAIM_RATE_LIMIT_PER_HOUR" default:"5"`

	// PurelyMail POP3 for the inbound catch-all. POP3 was picked
	// over IMAP because mailpit (our local-dev mail receiver) only
	// speaks POP3; using POP3 here too gives a single dev/prod code
	// path. The worker no-ops when PurelyMailPOP3Host is empty,
	// so local-dev runs that don't care about email skip the
	// connection entirely.
	PurelyMailPOP3Host     string `env:"PURELYMAIL_POP3_HOST" default:""`
	PurelyMailPOP3Port     int    `env:"PURELYMAIL_POP3_PORT" default:"995"`
	PurelyMailPOP3User     string `env:"PURELYMAIL_POP3_USER" default:""`
	PurelyMailPOP3Password string `env:"PURELYMAIL_POP3_PASSWORD" default:""`
	PurelyMailPOP3TLS      bool   `env:"PURELYMAIL_POP3_TLS" default:"true"`

	// Cloudflare R2 (S3-compatible) for user profile images. The avatar
	// service uploads resized images here and they're served via the CDN
	// at CloudflareCDNBaseURL (cdn.boson.chat). Avatar uploads no-op /
	// return an error when R2AccessKey is empty, so local-dev runs that
	// don't care about avatars don't need R2 configured. Real keys live in
	// the gitignored config.dev.json / prod env — never commit them.
	CloudflareR2AccessKey  string `env:"CLOUDFLARE_R2_ACCESS_KEY" default:""`
	CloudflareR2SecretKey  string `env:"CLOUDFLARE_R2_SECRET_KEY" default:""`
	CloudflareR2Endpoint   string `env:"CLOUDFLARE_R2_ENDPOINT" default:""`
	CloudflareR2Bucket     string `env:"CLOUDFLARE_R2_BUCKET" default:"boson"`
	CloudflareCDNBaseURL   string `env:"CLOUDFLARE_CDN_BASE_URL" default:"https://cdn.boson.chat"`
}

type DBConfig struct {
	Host     string `env:"DBHOST" default:"localhost"`
	Port     uint   `env:"DBPORT" default:"5432"`
	Database string `env:"DBNAME" default:"boson"`
	User     string `env:"DBUSERNAME" default:"boson"`
	Password string `env:"DBPASSWORD" default:"boson"`
	SSLMode  string `env:"DBSSLMODE" default:"disable"`
}

type AuthConfig struct {
	// JWKS URL for verifying Supabase-issued JWTs. Required at server start
	// (middleware panics if empty). Local default points at the Supabase CLI
	// stack; in production set to https://<project>.supabase.co/auth/v1/.well-known/jwks.json
	SupabaseJWKSURL string `env:"SUPABASE_JWKS_URL" default:"http://localhost:54321/auth/v1/.well-known/jwks.json"`
}

// LoadConfigOrPanic resolves config from the first matching JSON
// file under configFileSearchPaths() plus the process environment
// + struct-tag defaults. Missing JSON is fine (production), missing
// required-by-default isn't possible (every field has a default).
//
// Panics on a malformed JSON or a configor parse error so the
// failure surfaces at startup instead of producing a half-loaded
// Config silently.
func LoadConfigOrPanic() Config {
	var cfg Config

	// configor.Load(&cfg, paths...) walks the paths and merges
	// each existing file. Path resolution is CWD-relative, so we
	// try a few likely cwds (repo root + backend/ subdir) so
	// `make run` from any directory still picks up the dev file.
	files := existingFiles(configFileSearchPaths())
	if err := configor.Load(&cfg, files...); err != nil {
		panic(err)
	}
	return cfg
}

// configFileSearchPaths returns candidate config-file paths in
// precedence order. configor merges all that exist; later files
// override earlier ones. Today we only ship config.dev.json (for
// local dev); production sets env vars directly.
func configFileSearchPaths() []string {
	return []string{
		"backend/config/config.dev.json", // running from repo root
		"config/config.dev.json",         // running from backend/
		"../config/config.dev.json",      // running from backend/cmd/
	}
}

func existingFiles(paths []string) []string {
	out := make([]string, 0, len(paths))
	for _, p := range paths {
		if _, err := os.Stat(p); err == nil {
			// Skip duplicates so the same file (resolved via two
			// relative paths from different cwds) isn't merged
			// twice — harmless but noisy in logs.
			if absp, err := filepath.Abs(p); err == nil {
				seen := false
				for _, e := range out {
					if eabs, _ := filepath.Abs(e); eabs == absp {
						seen = true
						break
					}
				}
				if seen {
					continue
				}
			}
			out = append(out, p)
		}
	}
	return out
}
