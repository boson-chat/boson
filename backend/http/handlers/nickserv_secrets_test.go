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
	"github.com/boson-chat/boson/backend/internal/services/nickservsecret"

	"github.com/google/uuid"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

type stubNickservSecretService struct {
	list   func(ctx context.Context, userID uuid.UUID) ([]nickservsecret.NickservSecret, error)
	put    func(ctx context.Context, userID uuid.UUID, serverID string, ciphertext []byte) (*nickservsecret.NickservSecret, error)
	delete func(ctx context.Context, userID uuid.UUID, serverID string) error
}

func (s *stubNickservSecretService) List(ctx context.Context, uid uuid.UUID) ([]nickservsecret.NickservSecret, error) {
	return s.list(ctx, uid)
}
func (s *stubNickservSecretService) Put(ctx context.Context, uid uuid.UUID, sid string, ct []byte) (*nickservsecret.NickservSecret, error) {
	return s.put(ctx, uid, sid, ct)
}
func (s *stubNickservSecretService) Delete(ctx context.Context, uid uuid.UUID, sid string) error {
	return s.delete(ctx, uid, sid)
}

func callNickservSecrets(t *testing.T, svc nickservsecret.ServiceImpl, p middleware.Principal, method, path, body string) *httptest.ResponseRecorder {
	t.Helper()
	mux := stdhttp.NewServeMux()
	NewNickServSecretsHandler(svc).Register(mux)
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	if body != "" {
		req.Header.Set("Content-Type", "application/json")
	}
	req = req.WithContext(middleware.WithUser(context.Background(), p))
	rr := httptest.NewRecorder()
	mux.ServeHTTP(rr, req)
	return rr
}

func TestNickservSecrets_List(t *testing.T) {
	uid := uuid.New()
	svc := &stubNickservSecretService{
		list: func(_ context.Context, gotID uuid.UUID) ([]nickservsecret.NickservSecret, error) {
			assert.Equal(t, uid, gotID)
			return []nickservsecret.NickservSecret{
				{UserID: uid, ServerID: "srv-1", Ciphertext: []byte("abcd"), UpdatedAt: time.Now()},
			}, nil
		},
	}
	rr := callNickservSecrets(t, svc, middleware.Principal{UserID: uid}, "GET", "/me/nickserv-secrets", "")
	assert.Equal(t, stdhttp.StatusOK, rr.Code)

	var resp struct {
		Secrets []struct {
			ServerID   string `json:"server_id"`
			Ciphertext string `json:"ciphertext"`
		} `json:"secrets"`
	}
	require.NoError(t, json.NewDecoder(rr.Body).Decode(&resp))
	require.Len(t, resp.Secrets, 1)
	assert.Equal(t, "srv-1", resp.Secrets[0].ServerID)
	assert.Equal(t, "YWJjZA==", resp.Secrets[0].Ciphertext) // base64("abcd")
}

func TestNickservSecrets_Put(t *testing.T) {
	uid := uuid.New()
	svc := &stubNickservSecretService{
		put: func(_ context.Context, gotID uuid.UUID, sid string, ct []byte) (*nickservsecret.NickservSecret, error) {
			assert.Equal(t, uid, gotID)
			assert.Equal(t, "srv-1", sid)
			assert.Equal(t, []byte("abcd"), ct)
			return &nickservsecret.NickservSecret{UserID: uid, ServerID: sid, Ciphertext: ct, UpdatedAt: time.Now()}, nil
		},
	}
	rr := callNickservSecrets(t, svc, middleware.Principal{UserID: uid},
		"PUT", "/me/nickserv-secrets/srv-1", `{"ciphertext":"YWJjZA=="}`)
	assert.Equal(t, stdhttp.StatusOK, rr.Code)
}

func TestNickservSecrets_Put_BadBase64(t *testing.T) {
	svc := &stubNickservSecretService{
		put: func(_ context.Context, _ uuid.UUID, _ string, _ []byte) (*nickservsecret.NickservSecret, error) {
			t.Fatal("service should not be called on bad base64")
			return nil, nil
		},
	}
	rr := callNickservSecrets(t, svc, middleware.Principal{UserID: uuid.New()},
		"PUT", "/me/nickserv-secrets/srv-1", `{"ciphertext":"!!notb64"}`)
	assert.Equal(t, stdhttp.StatusBadRequest, rr.Code)
	assert.Contains(t, rr.Body.String(), "ciphertext must be base64")
}

func TestNickservSecrets_Delete_Idempotent(t *testing.T) {
	svc := &stubNickservSecretService{
		delete: func(_ context.Context, _ uuid.UUID, sid string) error {
			assert.Equal(t, "srv-1", sid)
			return nickservsecret.ErrNotFound // even when absent → 204
		},
	}
	rr := callNickservSecrets(t, svc, middleware.Principal{UserID: uuid.New()},
		"DELETE", "/me/nickserv-secrets/srv-1", "")
	assert.Equal(t, stdhttp.StatusNoContent, rr.Code)
}
