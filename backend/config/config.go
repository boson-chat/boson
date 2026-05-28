package config

import (
	"github.com/kelseyhightower/envconfig"
)

type Config struct {
	AppConfig  AppConfig
	DBConfig   DBConfig
	AuthConfig AuthConfig
}

type AppConfig struct {
	AppName        string `default:"boson"`
	Port           int    `envconfig:"PORT" default:"3000"`
	Env            string `envconfig:"ENV" default:"development"`
	AllowedOrigins string `envconfig:"ALLOWED_ORIGINS" default:"http://localhost:5173"`
	// Local-dev convenience: when true, POST /servers/{id}/verify auto-
	// succeeds without actually issuing any DNS queries. The verify
	// cron does the same. Avoids needing to own (and add a TXT record
	// to) a real public hostname when registering against a localhost
	// IRCd. Production deployments leave this OFF — Helm doesn't set
	// the env var in the prod chart.
	SkipDNSVerify bool `envconfig:"SKIP_DNS_VERIFY" default:"false"`
}

type DBConfig struct {
	Host     string `envconfig:"DBHOST" default:"localhost"`
	Port     uint   `envconfig:"DBPORT" default:"5432"`
	Database string `envconfig:"DBNAME" default:"boson"`
	User     string `envconfig:"DBUSERNAME" default:"boson"`
	Password string `envconfig:"DBPASSWORD" default:"boson"`
	SSLMode  string `envconfig:"DBSSLMODE" default:"disable"`
}

type AuthConfig struct {
	// JWKS URL for verifying Supabase-issued JWTs. Required at server start
	// (middleware panics if empty). Local default points at the Supabase CLI
	// stack; in production set to https://<project>.supabase.co/auth/v1/.well-known/jwks.json
	SupabaseJWKSURL string `envconfig:"SUPABASE_JWKS_URL" default:"http://localhost:54321/auth/v1/.well-known/jwks.json"`
}

func LoadConfigOrPanic() Config {
	var cfg Config
	if err := envconfig.Process("", &cfg); err != nil {
		panic(err)
	}
	return cfg
}
