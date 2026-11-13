package middleware

import (
	"context"
	"crypto/ecdsa"
	"crypto/ed25519"
	"crypto/elliptic"
	"crypto/rand"
	"errors"
	stdhttp "net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"

	"github.com/boson-chat/boson/backend/config"

	"github.com/MicahParks/jwkset"
	"github.com/golang-jwt/jwt/v5"
	"github.com/google/uuid"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

const (
	testIssuer   = "https://auth.test"
	testAudience = "boson"
)

// jwksFixture serves a JWKS like the auth service's: Ed25519 (OKP) keys.
type jwksFixture struct {
	storage jwkset.Storage
	priv    ed25519.PrivateKey
	kid     string
	url     string
	hits    atomic.Int32
	stop    func()
}

func newJWKSFixture(t *testing.T) *jwksFixture {
	t.Helper()
	f := &jwksFixture{storage: jwkset.NewMemoryStorage()}
	f.priv, f.kid = f.addKey(t, "key_1")
	srv := httptest.NewServer(stdhttp.HandlerFunc(func(w stdhttp.ResponseWriter, _ *stdhttp.Request) {
		f.hits.Add(1)
		raw, err := f.storage.JSONPublic(context.Background())
		if err != nil {
			stdhttp.Error(w, err.Error(), 500)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write(raw)
	}))
	f.url = srv.URL
	f.stop = srv.Close
	t.Cleanup(srv.Close)
	return f
}

func (f *jwksFixture) addKey(t *testing.T, kid string) (ed25519.PrivateKey, string) {
	t.Helper()
	_, priv, err := ed25519.GenerateKey(rand.Reader)
	require.NoError(t, err)
	jwk, err := jwkset.NewJWKFromKey(priv, jwkset.JWKOptions{
		Marshal:  jwkset.JWKMarshalOptions{Private: false},
		Metadata: jwkset.JWKMetadataOptions{KID: kid, ALG: jwkset.AlgEdDSA, USE: jwkset.UseSig},
	})
	require.NoError(t, err)
	require.NoError(t, f.storage.KeyWrite(context.Background(), jwk))
	return priv, kid
}

func validClaims(sub string) jwt.MapClaims {
	now := time.Now()
	return jwt.MapClaims{
		"iss":  testIssuer,
		"sub":  sub,
		"aud":  testAudience,
		"sid":  "ses_01J0000000000000000000000",
		"name": "alice",
		"role": "user",
		"iat":  now.Unix(),
		"nbf":  now.Unix(),
		"exp":  now.Add(15 * time.Minute).Unix(),
	}
}

func signEdDSA(t *testing.T, priv ed25519.PrivateKey, kid string, claims jwt.MapClaims, typ string) string {
	t.Helper()
	tok := jwt.NewWithClaims(jwt.SigningMethodEdDSA, claims)
	tok.Header["kid"] = kid
	if typ != "" {
		tok.Header["typ"] = typ
	}
	s, err := tok.SignedString(priv)
	require.NoError(t, err)
	return s
}

func (f *jwksFixture) sign(t *testing.T, claims jwt.MapClaims) string {
	return signEdDSA(t, f.priv, f.kid, claims, "at+jwt")
}

// mapResolver is an in-memory UserIDResolver.
type mapResolver struct {
	ids map[string]uuid.UUID
	err error
}

func (m *mapResolver) Resolve(_ context.Context, sub string) (uuid.UUID, error) {
	if m.err != nil {
		return uuid.Nil, m.err
	}
	if id, ok := m.ids[sub]; ok {
		return id, nil
	}
	return uuid.NewSHA1(uuid.NameSpaceURL, []byte(sub)), nil
}

func newVerifier(t *testing.T, url string) *Verifier {
	t.Helper()
	v, err := NewVerifier(context.Background(), config.AuthConfig{JWKSURL: url, Issuer: testIssuer, Audience: testAudience})
	require.NoError(t, err)
	return v
}

func newAuthHandler(t *testing.T, f *jwksFixture, r UserIDResolver) stdhttp.Handler {
	t.Helper()
	downstream := stdhttp.HandlerFunc(func(w stdhttp.ResponseWriter, r *stdhttp.Request) {
		p := MustUser(r.Context())
		_, _ = w.Write([]byte(p.UserID.String() + " " + p.AuthUserID + " " + p.Username + " " + p.Role))
	})
	return RequireAuth(newVerifier(t, f.url), r)(downstream)
}

func call(h stdhttp.Handler, token string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(stdhttp.MethodGet, "/me", nil)
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, req)
	return rr
}

func TestRequireAuth_AcceptsValidTokenAndResolvesImportedID(t *testing.T) {
	f := newJWKSFixture(t)
	supabaseID := uuid.New()
	h := newAuthHandler(t, f, &mapResolver{ids: map[string]uuid.UUID{"usr_01ALICE": supabaseID}})

	rr := call(h, f.sign(t, validClaims("usr_01ALICE")))

	assert.Equal(t, stdhttp.StatusOK, rr.Code)
	assert.Equal(t, supabaseID.String()+" usr_01ALICE alice user", rr.Body.String())
}

func TestRequireAuth_RejectsMissingBearer(t *testing.T) {
	f := newJWKSFixture(t)
	assert.Equal(t, stdhttp.StatusUnauthorized, call(newAuthHandler(t, f, &mapResolver{}), "").Code)
}

func TestRequireAuth_RejectsBogusToken(t *testing.T) {
	f := newJWKSFixture(t)
	assert.Equal(t, stdhttp.StatusUnauthorized, call(newAuthHandler(t, f, &mapResolver{}), "not.a.jwt").Code)
}

func TestRequireAuth_RejectsBadClaims(t *testing.T) {
	f := newJWKSFixture(t)
	h := newAuthHandler(t, f, &mapResolver{})
	cases := map[string]func(jwt.MapClaims){
		"expired":       func(c jwt.MapClaims) { c["exp"] = time.Now().Add(-time.Hour).Unix() },
		"no exp":        func(c jwt.MapClaims) { delete(c, "exp") },
		"wrong issuer":  func(c jwt.MapClaims) { c["iss"] = "https://evil.test" },
		"no issuer":     func(c jwt.MapClaims) { delete(c, "iss") },
		"voice aud":     func(c jwt.MapClaims) { c["aud"] = "quicvoice" },
		"no aud":        func(c jwt.MapClaims) { delete(c, "aud") },
		"no sub":        func(c jwt.MapClaims) { delete(c, "sub") },
		"supabase uuid": func(c jwt.MapClaims) { c["sub"] = uuid.NewString() },
	}
	for name, mutate := range cases {
		t.Run(name, func(t *testing.T) {
			c := validClaims("usr_01ALICE")
			mutate(c)
			assert.Equal(t, stdhttp.StatusUnauthorized, call(h, f.sign(t, c)).Code)
		})
	}
}

func TestRequireAuth_RejectsNonAccessTokenTyp(t *testing.T) {
	f := newJWKSFixture(t)
	h := newAuthHandler(t, f, &mapResolver{})
	// Voice tokens carry typ JWT.
	assert.Equal(t, stdhttp.StatusUnauthorized, call(h, signEdDSA(t, f.priv, f.kid, validClaims("usr_01ALICE"), "JWT")).Code)
	assert.Equal(t, stdhttp.StatusUnauthorized, call(h, signEdDSA(t, f.priv, f.kid, validClaims("usr_01ALICE"), "")).Code)
}

func TestRequireAuth_RejectsOtherAlgorithms(t *testing.T) {
	f := newJWKSFixture(t)
	h := newAuthHandler(t, f, &mapResolver{})

	// ES256 with a key that IS in the JWKS: still refused, EdDSA only.
	ec, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	require.NoError(t, err)
	jwk, err := jwkset.NewJWKFromKey(ec, jwkset.JWKOptions{Metadata: jwkset.JWKMetadataOptions{KID: "ec"}})
	require.NoError(t, err)
	require.NoError(t, f.storage.KeyWrite(context.Background(), jwk))
	tok := jwt.NewWithClaims(jwt.SigningMethodES256, validClaims("usr_01ALICE"))
	tok.Header["kid"] = "ec"
	tok.Header["typ"] = "at+jwt"
	es, err := tok.SignedString(ec)
	require.NoError(t, err)
	assert.Equal(t, stdhttp.StatusUnauthorized, call(h, es).Code)

	// HS256 and none.
	hs := jwt.NewWithClaims(jwt.SigningMethodHS256, validClaims("usr_01ALICE"))
	hs.Header["kid"] = f.kid
	hs.Header["typ"] = "at+jwt"
	hss, err := hs.SignedString([]byte("secret"))
	require.NoError(t, err)
	assert.Equal(t, stdhttp.StatusUnauthorized, call(h, hss).Code)
	none := jwt.NewWithClaims(jwt.SigningMethodNone, validClaims("usr_01ALICE"))
	nones, err := none.SignedString(jwt.UnsafeAllowNoneSignatureType)
	require.NoError(t, err)
	assert.Equal(t, stdhttp.StatusUnauthorized, call(h, nones).Code)
}

func TestRequireAuth_RejectsForeignKey(t *testing.T) {
	f := newJWKSFixture(t)
	h := newAuthHandler(t, f, &mapResolver{})
	_, other, err := ed25519.GenerateKey(rand.Reader)
	require.NoError(t, err)
	assert.Equal(t, stdhttp.StatusUnauthorized, call(h, signEdDSA(t, other, f.kid, validClaims("usr_01ALICE"), "at+jwt")).Code)
}

func TestRequireAuth_RefetchesJWKSOnUnknownKid(t *testing.T) {
	f := newJWKSFixture(t)
	h := newAuthHandler(t, f, &mapResolver{})
	require.Equal(t, stdhttp.StatusOK, call(h, f.sign(t, validClaims("usr_01ALICE"))).Code)

	// The auth service rotates: a new key appears after our first fetch.
	priv2, kid2 := f.addKey(t, "key_2")
	rr := call(h, signEdDSA(t, priv2, kid2, validClaims("usr_01ALICE"), "at+jwt"))
	assert.Equal(t, stdhttp.StatusOK, rr.Code)
	assert.GreaterOrEqual(t, f.hits.Load(), int32(2))
}

func TestRequireAuth_ResolverErrorIs500(t *testing.T) {
	f := newJWKSFixture(t)
	h := newAuthHandler(t, f, &mapResolver{err: errors.New("db down")})
	assert.Equal(t, stdhttp.StatusInternalServerError, call(h, f.sign(t, validClaims("usr_01ALICE"))).Code)
}

func TestNewVerifier_RequiresConfig(t *testing.T) {
	for _, cfg := range []config.AuthConfig{
		{Issuer: testIssuer, Audience: testAudience},
		{JWKSURL: "http://x", Audience: testAudience},
		{JWKSURL: "http://x", Issuer: testIssuer},
	} {
		_, err := NewVerifier(context.Background(), cfg)
		assert.Error(t, err)
	}
}

func TestRequireAuth_PanicsWithoutDeps(t *testing.T) {
	assert.Panics(t, func() { _ = RequireAuth(nil, &mapResolver{}) })
}

func TestUserFromCtx_ReturnsFalseWhenAbsent(t *testing.T) {
	_, ok := UserFromCtx(context.Background())
	assert.False(t, ok)
}

func TestMustUser_PanicsWhenAbsent(t *testing.T) {
	assert.Panics(t, func() { _ = MustUser(context.Background()) })
}
