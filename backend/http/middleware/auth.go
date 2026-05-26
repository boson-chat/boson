package middleware

import (
	"context"
	"errors"
	stdhttp "net/http"
	"strings"
	"time"

	"github.com/boson-chat/boson/backend/config"

	"github.com/MicahParks/keyfunc/v3"
	"github.com/golang-jwt/jwt/v5"
	"github.com/google/uuid"
)

type ctxKey struct{}

type Principal struct {
	UserID uuid.UUID
	Email  string
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

// RequireAuth verifies a Supabase-issued JWT against the configured JWKS
// endpoint and stores the principal in the request context.
func RequireAuth(cfg config.AuthConfig) func(stdhttp.Handler) stdhttp.Handler {
	if cfg.SupabaseJWKSURL == "" {
		panic("SUPABASE_JWKS_URL is required")
	}

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	k, err := keyfunc.NewDefaultCtx(ctx, []string{cfg.SupabaseJWKSURL})
	if err != nil {
		panic("failed to load JWKS from " + cfg.SupabaseJWKSURL + ": " + err.Error())
	}

	return func(next stdhttp.Handler) stdhttp.Handler {
		return stdhttp.HandlerFunc(func(w stdhttp.ResponseWriter, r *stdhttp.Request) {
			principal, err := verifyBearer(r, k.Keyfunc)
			if err != nil {
				stdhttp.Error(w, err.Error(), stdhttp.StatusUnauthorized)
				return
			}
			ctx := context.WithValue(r.Context(), ctxKey{}, principal)
			next.ServeHTTP(w, r.WithContext(ctx))
		})
	}
}

func verifyBearer(r *stdhttp.Request, kf jwt.Keyfunc) (Principal, error) {
	authz := r.Header.Get("Authorization")
	if !strings.HasPrefix(authz, "Bearer ") {
		return Principal{}, errors.New("missing bearer token")
	}
	tokenStr := strings.TrimPrefix(authz, "Bearer ")

	claims := jwt.MapClaims{}
	_, err := jwt.ParseWithClaims(tokenStr, claims, kf)
	if err != nil {
		return Principal{}, err
	}

	sub, _ := claims["sub"].(string)
	if sub == "" {
		return Principal{}, errors.New("token missing sub")
	}
	id, err := uuid.Parse(sub)
	if err != nil {
		return Principal{}, errors.New("token sub is not a UUID")
	}
	email, _ := claims["email"].(string)
	return Principal{UserID: id, Email: email}, nil
}
