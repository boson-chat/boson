package config

import (
	"os"
	"testing"

	"github.com/stretchr/testify/assert"
)

// envKeys are the env vars consumed by this package. The test suite
// unsets them in TestMain so default values are observable.
var envKeys = []string{
	"PORT", "ENV", "ALLOWED_ORIGINS",
	"DBHOST", "DBPORT", "DBNAME", "DBUSERNAME", "DBPASSWORD", "DBSSLMODE",
	"AUTH_JWKS_URL", "AUTH_ISSUER", "AUTH_AUDIENCE",
}

func TestMain(m *testing.M) {
	saved := map[string]string{}
	for _, k := range envKeys {
		if v, ok := os.LookupEnv(k); ok {
			saved[k] = v
		}
		os.Unsetenv(k)
	}
	code := m.Run()
	for k, v := range saved {
		os.Setenv(k, v)
	}
	os.Exit(code)
}

func TestLoadConfigOrPanic_Defaults(t *testing.T) {
	cfg := LoadConfigOrPanic()

	assert.Equal(t, "boson", cfg.AppConfig.AppName)
	assert.Equal(t, 3000, cfg.AppConfig.Port)
	assert.Equal(t, "development", cfg.AppConfig.Env)
	assert.Equal(t, "http://localhost:5173", cfg.AppConfig.AllowedOrigins)

	assert.Equal(t, "localhost", cfg.DBConfig.Host)
	assert.EqualValues(t, 5432, cfg.DBConfig.Port)
	assert.Equal(t, "boson", cfg.DBConfig.Database)
	assert.Equal(t, "boson", cfg.DBConfig.User)
	assert.Equal(t, "disable", cfg.DBConfig.SSLMode)

	assert.Equal(t, "http://localhost:8080/.well-known/jwks.json", cfg.AuthConfig.JWKSURL)
	assert.Equal(t, "http://localhost:8080", cfg.AuthConfig.Issuer)
	assert.Equal(t, "boson", cfg.AuthConfig.Audience)
}

func TestLoadConfigOrPanic_EnvOverrides(t *testing.T) {
	t.Setenv("PORT", "8080")
	t.Setenv("ENV", "staging")
	t.Setenv("DBHOST", "prod-db.internal")
	t.Setenv("DBPORT", "6432")
	t.Setenv("AUTH_JWKS_URL", "https://auth.boson.chat/.well-known/jwks.json")
	t.Setenv("AUTH_ISSUER", "https://auth.boson.chat")
	t.Setenv("ALLOWED_ORIGINS", "https://app.example.com,https://admin.example.com")

	cfg := LoadConfigOrPanic()

	assert.Equal(t, 8080, cfg.AppConfig.Port)
	assert.Equal(t, "staging", cfg.AppConfig.Env)
	assert.Equal(t, "prod-db.internal", cfg.DBConfig.Host)
	assert.EqualValues(t, 6432, cfg.DBConfig.Port)
	assert.Equal(t, "https://auth.boson.chat/.well-known/jwks.json", cfg.AuthConfig.JWKSURL)
	assert.Equal(t, "https://auth.boson.chat", cfg.AuthConfig.Issuer)
	assert.Equal(t, "boson", cfg.AuthConfig.Audience)
	assert.Equal(t, "https://app.example.com,https://admin.example.com", cfg.AppConfig.AllowedOrigins)
}
