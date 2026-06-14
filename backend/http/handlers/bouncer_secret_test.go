package handlers

import (
	"context"
	"encoding/json"
	stdhttp "net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/boson-chat/boson/backend/http/middleware"
	"github.com/boson-chat/boson/backend/internal/services/bouncersecret"

	"github.com/google/uuid"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

type stubBouncerSecretService struct {
	get    func(ctx context.Context, userID uuid.UUID) (*bouncersecret.BouncerSecret, error)
	put    func(ctx context.Context, userID uuid.UUID, ciphertext []byte) (*bouncersecret.BouncerSecret, error)
	delete func(ctx context.Context, userID uuid.UUID) error
}

func (s *stubBouncerSecretService) Get(ctx context.Context, uid uuid.UUID) (*bouncersecret.BouncerSecret, error) {
	return s.get(ctx, uid)
}
func (s *stubBouncerSecretService) Put(ctx context.Context, uid uuid.UUID, ct []byte) (*bouncersecret.BouncerSecret, error) {
	return s.put(ctx, uid, ct)
}
func (s *stubBouncerSecretService) Delete(ctx context.Context, uid uuid.UUID) error {
	return s.delete(ctx, uid)
}

func callBouncer(t *testing.T, svc bouncersecret.ServiceImpl, p middleware.Principal, method, body string) *httptest.ResponseRecorder {
	t.Helper()
	mux := stdhttp.NewServeMux()
	NewBouncerSecretHandler(svc).Register(mux)
	req := httptest.NewRequest(method, "/me/bouncer", strings.NewReader(body))
	if body != "" {
		req.Header.Set("Content-Type", "application/json")
	}
	req = req.WithContext(middleware.WithUser(context.Background(), p))
	rr := httptest.NewRecorder()
	mux.ServeHTTP(rr, req)
	return rr
}

func TestBouncer_Get(t *testing.T) {
	uid := uuid.New()
	svc := &stubBouncerSecretService{
		get: func(_ context.Context, gotID uuid.UUID) (*bouncersecret.BouncerSecret, error) {
			assert.Equal(t, uid, gotID) // principal scoping = RLS boundary
			return &bouncersecret.BouncerSecret{UserID: uid, Ciphertext: []byte("abcd"), UpdatedAt: time.Now()}, nil
		},
	}
	rr := callBouncer(t, svc, middleware.Principal{UserID: uid}, "GET", "")
	assert.Equal(t, stdhttp.StatusOK, rr.Code)

	var resp struct {
		Bouncer *struct {
			Ciphertext string `json:"ciphertext"`
		} `json:"bouncer"`
	}
	require.NoError(t, json.NewDecoder(rr.Body).Decode(&resp))
	require.NotNil(t, resp.Bouncer)
	assert.Equal(t, "YWJjZA==", resp.Bouncer.Ciphertext) // base64("abcd")
}

func TestBouncer_Get_NullWhenAbsent(t *testing.T) {
	svc := &stubBouncerSecretService{
		get: func(_ context.Context, _ uuid.UUID) (*bouncersecret.BouncerSecret, error) {
			return nil, bouncersecret.ErrNotFound
		},
	}
	rr := callBouncer(t, svc, middleware.Principal{UserID: uuid.New()}, "GET", "")
	assert.Equal(t, stdhttp.StatusOK, rr.Code)

	var resp struct {
		Bouncer *json.RawMessage `json:"bouncer"`
	}
	require.NoError(t, json.NewDecoder(rr.Body).Decode(&resp))
	assert.Nil(t, resp.Bouncer, "absent profile must serialize as null")
}

func TestBouncer_Put(t *testing.T) {
	uid := uuid.New()
	svc := &stubBouncerSecretService{
		put: func(_ context.Context, gotID uuid.UUID, ct []byte) (*bouncersecret.BouncerSecret, error) {
			assert.Equal(t, uid, gotID)
			assert.Equal(t, []byte("abcd"), ct)
			return &bouncersecret.BouncerSecret{UserID: uid, Ciphertext: ct, UpdatedAt: time.Now()}, nil
		},
	}
	rr := callBouncer(t, svc, middleware.Principal{UserID: uid}, "PUT", `{"ciphertext":"YWJjZA=="}`)
	assert.Equal(t, stdhttp.StatusOK, rr.Code)
}

func TestBouncer_Put_BadBase64(t *testing.T) {
	svc := &stubBouncerSecretService{
		put: func(_ context.Context, _ uuid.UUID, _ []byte) (*bouncersecret.BouncerSecret, error) {
			t.Fatal("service should not be called on bad base64")
			return nil, nil
		},
	}
	rr := callBouncer(t, svc, middleware.Principal{UserID: uuid.New()}, "PUT", `{"ciphertext":"!!notb64"}`)
	assert.Equal(t, stdhttp.StatusBadRequest, rr.Code)
	assert.Contains(t, rr.Body.String(), "ciphertext must be base64")
}

func TestBouncer_Put_EmptyRejected(t *testing.T) {
	svc := &stubBouncerSecretService{
		put: func(_ context.Context, _ uuid.UUID, ct []byte) (*bouncersecret.BouncerSecret, error) {
			return nil, bouncersecret.ErrEmptyCiphertext
		},
	}
	rr := callBouncer(t, svc, middleware.Principal{UserID: uuid.New()}, "PUT", `{"ciphertext":""}`)
	assert.Equal(t, stdhttp.StatusBadRequest, rr.Code)
	assert.Contains(t, rr.Body.String(), "ciphertext is required")
}

func TestBouncer_Delete_Idempotent(t *testing.T) {
	called := false
	svc := &stubBouncerSecretService{
		delete: func(_ context.Context, _ uuid.UUID) error { called = true; return nil },
	}
	rr := callBouncer(t, svc, middleware.Principal{UserID: uuid.New()}, "DELETE", "")
	assert.Equal(t, stdhttp.StatusNoContent, rr.Code)
	assert.True(t, called)
}
