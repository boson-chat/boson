package middleware

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	stdhttp "net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/boson-chat/boson/backend/config"

	"github.com/MicahParks/jwkset"
	"github.com/golang-jwt/jwt/v5"
	"github.com/google/uuid"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

type jwksFixture struct {
	privKey *ecdsa.PrivateKey
	kid     string
	jwksURL string
	stop    func()
}

func newJWKSFixture(t *testing.T) *jwksFixture {
	t.Helper()

	priv, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	require.NoError(t, err)

	kid := "test-key-1"
	storage := jwkset.NewMemoryStorage()
	jwk, err := jwkset.NewJWKFromKey(priv, jwkset.JWKOptions{
		Marshal:  jwkset.JWKMarshalOptions{Private: false},
		Metadata: jwkset.JWKMetadataOptions{KID: kid},
	})
	require.NoError(t, err)
	require.NoError(t, storage.KeyWrite(context.Background(), jwk))

	srv := httptest.NewServer(stdhttp.HandlerFunc(func(w stdhttp.ResponseWriter, _ *stdhttp.Request) {
		raw, err := storage.JSONPublic(context.Background())
		if err != nil {
			stdhttp.Error(w, err.Error(), 500)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write(raw)
	}))

	return &jwksFixture{
		privKey: priv,
		kid:     kid,
		jwksURL: srv.URL,
		stop:    srv.Close,
	}
}

func (f *jwksFixture) sign(t *testing.T, claims jwt.MapClaims) string {
	t.Helper()
	tok := jwt.NewWithClaims(jwt.SigningMethodES256, claims)
	tok.Header["kid"] = f.kid
	signed, err := tok.SignedString(f.privKey)
	require.NoError(t, err)
	return signed
}

func newAuthHandler(t *testing.T, cfg config.AuthConfig) stdhttp.Handler {
	t.Helper()
	downstream := stdhttp.HandlerFunc(func(w stdhttp.ResponseWriter, r *stdhttp.Request) {
		p := MustUser(r.Context())
		_, _ = w.Write([]byte(p.UserID.String()))
	})
	return RequireAuth(cfg)(downstream)
}

func TestRequireAuth_AcceptsValidToken(t *testing.T) {
	jwks := newJWKSFixture(t)
	defer jwks.stop()

	userID := uuid.New()
	token := jwks.sign(t, jwt.MapClaims{
		"sub":   userID.String(),
		"email": "alice@example.com",
		"exp":   time.Now().Add(time.Hour).Unix(),
		"iat":   time.Now().Unix(),
	})

	h := newAuthHandler(t, config.AuthConfig{SupabaseJWKSURL: jwks.jwksURL})
	req := httptest.NewRequest(stdhttp.MethodGet, "/me", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, req)

	assert.Equal(t, stdhttp.StatusOK, rr.Code)
	assert.Equal(t, userID.String(), rr.Body.String())
}

func TestRequireAuth_RejectsMissingBearer(t *testing.T) {
	jwks := newJWKSFixture(t)
	defer jwks.stop()

	h := newAuthHandler(t, config.AuthConfig{SupabaseJWKSURL: jwks.jwksURL})
	req := httptest.NewRequest(stdhttp.MethodGet, "/me", nil)
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, req)

	assert.Equal(t, stdhttp.StatusUnauthorized, rr.Code)
}

func TestRequireAuth_RejectsBogusToken(t *testing.T) {
	jwks := newJWKSFixture(t)
	defer jwks.stop()

	h := newAuthHandler(t, config.AuthConfig{SupabaseJWKSURL: jwks.jwksURL})
	req := httptest.NewRequest(stdhttp.MethodGet, "/me", nil)
	req.Header.Set("Authorization", "Bearer not.a.jwt")
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, req)

	assert.Equal(t, stdhttp.StatusUnauthorized, rr.Code)
}

func TestRequireAuth_RejectsExpiredToken(t *testing.T) {
	jwks := newJWKSFixture(t)
	defer jwks.stop()

	token := jwks.sign(t, jwt.MapClaims{
		"sub": uuid.New().String(),
		"exp": time.Now().Add(-time.Hour).Unix(),
		"iat": time.Now().Add(-2 * time.Hour).Unix(),
	})

	h := newAuthHandler(t, config.AuthConfig{SupabaseJWKSURL: jwks.jwksURL})
	req := httptest.NewRequest(stdhttp.MethodGet, "/me", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, req)

	assert.Equal(t, stdhttp.StatusUnauthorized, rr.Code)
}

func TestRequireAuth_RejectsNonUUIDSub(t *testing.T) {
	jwks := newJWKSFixture(t)
	defer jwks.stop()

	token := jwks.sign(t, jwt.MapClaims{
		"sub": "not-a-uuid",
		"exp": time.Now().Add(time.Hour).Unix(),
	})

	h := newAuthHandler(t, config.AuthConfig{SupabaseJWKSURL: jwks.jwksURL})
	req := httptest.NewRequest(stdhttp.MethodGet, "/me", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, req)

	assert.Equal(t, stdhttp.StatusUnauthorized, rr.Code)
}

func TestRequireAuth_PanicsOnEmptyJWKSURL(t *testing.T) {
	assert.Panics(t, func() {
		_ = RequireAuth(config.AuthConfig{SupabaseJWKSURL: ""})
	})
}

func TestUserFromCtx_ReturnsFalseWhenAbsent(t *testing.T) {
	_, ok := UserFromCtx(context.Background())
	assert.False(t, ok)
}

func TestMustUser_PanicsWhenAbsent(t *testing.T) {
	assert.Panics(t, func() { _ = MustUser(context.Background()) })
}
