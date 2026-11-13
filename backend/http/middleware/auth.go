package middleware

import (
	"context"
	"errors"
	"fmt"
	stdhttp "net/http"
	"strings"
	"time"

	"github.com/boson-chat/boson/backend/config"

	"github.com/MicahParks/keyfunc/v3"
	"github.com/golang-jwt/jwt/v5"
	"github.com/google/uuid"
	"github.com/rs/zerolog/log"
)

type ctxKey struct{}

type Principal struct {
	// UserID is boson's id for the caller (users.id and every user_id
	// column), resolved from the token's sub via auth_identities.
	UserID uuid.UUID
	// AuthUserID is the auth service's id (the token's sub, usr_<ULID>).
	AuthUserID string
	// Username is the auth-service username (an IRC nick) from the `name`
	// claim. Informational: boson's handle lives in users.handle.
	Username string
	// Role is `user` or `admin` from the token.
	Role string
}

func UserFromCtx(ctx context.Context) (Principal, bool) {
	p, ok := ctx.Value(ctxKey{}).(Principal)
	return p, ok
}

func MustUser(ctx context.Context) Principal {
	p, ok := UserFromCtx(ctx)
	if !ok {
		panic("middleware.MustUser called outside of an authenticated route")
	}
	return p
}

// WithUser stores a principal in the context. Normally only RequireAuth
// calls this; exported so tests can drive downstream handlers directly.
func WithUser(ctx context.Context, p Principal) context.Context {
	return context.WithValue(ctx, ctxKey{}, p)
}

// UserIDResolver maps an auth-service user id (sub) to the boson user id.
// Implemented by authidentity.Service.
type UserIDResolver interface {
	Resolve(ctx context.Context, authUserID string) (uuid.UUID, error)
}

// accessClaims are the claims of an auth-service access token.
type accessClaims struct {
	jwt.RegisteredClaims
	SessionID string `json:"sid"`
	Name      string `json:"name"`
	Role      string `json:"role"`
}

// Verifier checks auth-service access tokens: EdDSA only, a key from the
// JWKS (cached, refetched on an unknown kid), typ at+jwt, and exp / iss /
// aud required.
type Verifier struct {
	keys     jwt.Keyfunc
	issuer   string
	audience string
}

// NewVerifier starts the JWKS cache. The JWKS being unreachable at startup
// isn't fatal (keyfunc keeps retrying); tokens fail until it loads.
func NewVerifier(ctx context.Context, cfg config.AuthConfig) (*Verifier, error) {
	if cfg.JWKSURL == "" {
		return nil, errors.New("AUTH_JWKS_URL is required")
	}
	if cfg.Issuer == "" {
		return nil, errors.New("AUTH_ISSUER is required")
	}
	if cfg.Audience == "" {
		return nil, errors.New("AUTH_AUDIENCE is required")
	}
	k, err := keyfunc.NewDefaultCtx(ctx, []string{cfg.JWKSURL})
	if err != nil {
		return nil, fmt.Errorf("JWKS %s: %w", cfg.JWKSURL, err)
	}
	return &Verifier{keys: k.Keyfunc, issuer: cfg.Issuer, audience: cfg.Audience}, nil
}

// Verify parses and validates an access token.
func (v *Verifier) Verify(token string) (*accessClaims, error) {
	var c accessClaims
	t, err := jwt.ParseWithClaims(token, &c, v.keys,
		jwt.WithValidMethods([]string{"EdDSA"}),
		jwt.WithExpirationRequired(),
		jwt.WithIssuer(v.issuer),
		jwt.WithAudience(v.audience),
		jwt.WithLeeway(30*time.Second),
	)
	if err != nil {
		return nil, err
	}
	// typ at+jwt keeps other tokens from this issuer (e.g. voice tokens,
	// which also have a different aud) out.
	if typ, _ := t.Header["typ"].(string); !strings.EqualFold(typ, "at+jwt") {
		return nil, errors.New("not an access token")
	}
	if c.Subject == "" {
		return nil, errors.New("token missing sub")
	}
	return &c, nil
}

// RequireAuth verifies an auth-service access token and stores the
// principal in the request context.
func RequireAuth(v *Verifier, resolver UserIDResolver) func(stdhttp.Handler) stdhttp.Handler {
	if v == nil || resolver == nil {
		panic("RequireAuth needs a verifier and a resolver")
	}
	return func(next stdhttp.Handler) stdhttp.Handler {
		return stdhttp.HandlerFunc(func(w stdhttp.ResponseWriter, r *stdhttp.Request) {
			authz := r.Header.Get("Authorization")
			if !strings.HasPrefix(authz, "Bearer ") {
				stdhttp.Error(w, "missing bearer token", stdhttp.StatusUnauthorized)
				return
			}
			c, err := v.Verify(strings.TrimPrefix(authz, "Bearer "))
			if err != nil {
				stdhttp.Error(w, "invalid token", stdhttp.StatusUnauthorized)
				return
			}
			if !strings.HasPrefix(c.Subject, "usr_") {
				stdhttp.Error(w, "invalid token", stdhttp.StatusUnauthorized)
				return
			}
			id, err := resolver.Resolve(r.Context(), c.Subject)
			if err != nil {
				log.Error().Err(err).Str("sub", c.Subject).Msg("auth: resolve user id")
				stdhttp.Error(w, "could not resolve user", stdhttp.StatusInternalServerError)
				return
			}
			p := Principal{UserID: id, AuthUserID: c.Subject, Username: c.Name, Role: c.Role}
			next.ServeHTTP(w, r.WithContext(WithUser(r.Context(), p)))
		})
	}
}
