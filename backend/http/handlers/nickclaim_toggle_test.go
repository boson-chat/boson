package handlers

import (
	"context"
	"encoding/json"
	"net/http/httptest"
	"strings"
	"testing"

	stdhttp "net/http"

	"github.com/boson-chat/boson/backend/http/middleware"
	"github.com/boson-chat/boson/backend/internal/configfile"
	"github.com/boson-chat/boson/backend/internal/services/nickclaim"

	"github.com/google/uuid"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestNickClaimsHandler_Create_Disabled403(t *testing.T) {
	svc := &stubNickClaimService{
		disabled: true,
		createClaim: func(context.Context, uuid.UUID, string, string) (*nickclaim.NickClaim, error) {
			t.Fatal("CreateClaim must not run while disabled")
			return nil, nil
		},
	}
	// Even an invalid body gets the 403: the feature is off, full stop.
	for _, body := range []string{`{"server_id":"s","account_nick":"n"}`, `not json`} {
		rr := callNickClaims(t, svc, middleware.Principal{UserID: uuid.New()}, "POST", "/me/nick-claims", body)
		assert.Equal(t, stdhttp.StatusForbidden, rr.Code)
		assert.JSONEq(t, `{"error":"nick_claim_disabled"}`, rr.Body.String())
	}
}

func TestNickClaimsHandler_Create_DisabledRace403(t *testing.T) {
	// Enabled at the check, disabled by a reload before the insert.
	svc := &stubNickClaimService{
		createClaim: func(context.Context, uuid.UUID, string, string) (*nickclaim.NickClaim, error) {
			return nil, nickclaim.ErrDisabled
		},
	}
	rr := callNickClaims(t, svc, middleware.Principal{UserID: uuid.New()}, "POST", "/me/nick-claims", `{"server_id":"s","account_nick":"n"}`)
	assert.Equal(t, stdhttp.StatusForbidden, rr.Code)
	assert.JSONEq(t, `{"error":"nick_claim_disabled"}`, rr.Body.String())
}

func TestNickClaimsHandler_Get_WorksWhileDisabled(t *testing.T) {
	code := "c0de"
	svc := &stubNickClaimService{
		disabled: true,
		consumeIfCaptured: func(_ context.Context, id, _ uuid.UUID) (*nickclaim.NickClaim, error) {
			return &nickclaim.NickClaim{ID: id, Status: nickclaim.StatusConsumed, Code: &code}, nil
		},
	}
	rr := callNickClaims(t, svc, middleware.Principal{UserID: uuid.New()}, "GET", "/me/nick-claims/"+uuid.NewString(), "")
	assert.Equal(t, stdhttp.StatusOK, rr.Code)
	assert.JSONEq(t, `{"status":"consumed","code":"c0de"}`, rr.Body.String())
}

func TestPublicConfigHandler(t *testing.T) {
	svc := &stubNickClaimService{disabled: true}
	mux := stdhttp.NewServeMux()
	NewPublicConfigHandler(svc).Register(mux)

	get := func() *httptest.ResponseRecorder {
		rr := httptest.NewRecorder()
		mux.ServeHTTP(rr, httptest.NewRequest("GET", "/config", nil))
		return rr
	}
	rr := get()
	assert.Equal(t, stdhttp.StatusOK, rr.Code)
	assert.JSONEq(t, `{"nick_claim":false}`, rr.Body.String())
	assert.Equal(t, "no-store", rr.Header().Get("Cache-Control"))

	svc.disabled = false
	assert.JSONEq(t, `{"nick_claim":true}`, get().Body.String())
}

// ---- internal listener ----------------------------------------------

type stubRuntime struct {
	settings nickclaim.Settings
	status   nickclaim.Status
	tested   *nickclaim.WorkerConfig
}

func (s *stubRuntime) Apply(_ context.Context, st nickclaim.Settings) { s.settings = st }
func (s *stubRuntime) Settings() nickclaim.Settings                   { return s.settings }
func (s *stubRuntime) Status(context.Context) (nickclaim.Status, error) {
	return s.status, nil
}
func (s *stubRuntime) TestInbound(_ context.Context, cfg nickclaim.WorkerConfig) nickclaim.TestResult {
	s.tested = &cfg
	return nickclaim.TestResult{OK: true, Message: "ok", Messages: 1}
}
func (s *stubRuntime) Stop() {}
func (s *stubRuntime) Summary() nickclaim.Summary {
	return nickclaim.Summary{Enabled: s.status.Enabled, Worker: nickclaim.WorkerStopped}
}

func callInternal(t *testing.T, h *InternalHandler, method, path, token, body string) *httptest.ResponseRecorder {
	t.Helper()
	mux := stdhttp.NewServeMux()
	h.Register(mux)
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	if token != "" {
		req.Header.Set(InternalTokenHeader, token)
	}
	rr := httptest.NewRecorder()
	mux.ServeHTTP(rr, req)
	return rr
}

func TestInternal_TokenGuard(t *testing.T) {
	rt := &stubRuntime{}
	h := NewInternalHandler(rt, "s3cret", nil)
	for _, p := range []struct{ method, path string }{
		{"GET", "/internal/nick-claims/status"},
		{"POST", "/internal/nick-claims/test"},
	} {
		rr := callInternal(t, h, p.method, p.path, "", "")
		assert.Equal(t, stdhttp.StatusUnauthorized, rr.Code, p.path)
		rr = callInternal(t, h, p.method, p.path, "wrong", "")
		assert.Equal(t, stdhttp.StatusUnauthorized, rr.Code, p.path)
	}
	// Bearer works too.
	mux := stdhttp.NewServeMux()
	h.Register(mux)
	req := httptest.NewRequest("GET", "/internal/nick-claims/status", nil)
	req.Header.Set("Authorization", "Bearer s3cret")
	rr := httptest.NewRecorder()
	mux.ServeHTTP(rr, req)
	assert.Equal(t, stdhttp.StatusOK, rr.Code)
	req = httptest.NewRequest("GET", "/internal/nick-claims/status", nil)
	req.Header.Set("Authorization", "Bearer wrong")
	rr = httptest.NewRecorder()
	mux.ServeHTTP(rr, req)
	assert.Equal(t, stdhttp.StatusUnauthorized, rr.Code)

	// No token configured: the endpoints are off.
	rr = callInternal(t, NewInternalHandler(rt, "", nil), "GET", "/internal/nick-claims/status", "anything", "")
	assert.Equal(t, stdhttp.StatusServiceUnavailable, rr.Code)
	assert.JSONEq(t, `{"error":"internal_api_disabled"}`, rr.Body.String())
}

func TestInternal_ConfigStatusNeedsNoToken(t *testing.T) {
	rr := callInternal(t, NewInternalHandler(&stubRuntime{}, "s3cret", nil), "GET", "/internal/config/status", "", "")
	assert.Equal(t, stdhttp.StatusOK, rr.Code)
	var st map[string]any
	require.NoError(t, json.Unmarshal(rr.Body.Bytes(), &st))
	assert.Equal(t, false, st["enabled"])
	assert.Equal(t, true, st["ok"])
	assert.Equal(t, []any{}, st["restart_required"])
	assert.Equal(t, map[string]any{"enabled": false, "worker": "stopped", "last_poll_at": nil}, st["nick_claim"])

	status := func() configfile.Status {
		return configfile.Status{Enabled: true, Path: "/config/boson.yaml", OK: true}
	}
	rr = callInternal(t, NewInternalHandler(&stubRuntime{}, "s3cret", status), "GET", "/internal/config/status", "", "")
	assert.Contains(t, rr.Body.String(), `"path":"/config/boson.yaml"`)

	rr = callInternal(t, NewInternalHandler(&stubRuntime{}, "", nil), "GET", "/healthz", "", "")
	assert.Equal(t, stdhttp.StatusOK, rr.Code)
}

func TestInternal_NickClaimStatusShape(t *testing.T) {
	rt := &stubRuntime{status: nickclaim.Status{
		Enabled:       true,
		EmailDomain:   "example.com",
		Inbound:       nickclaim.InboundStatus{Host: "pop3.example.com", Port: 995, TLS: true, User: "reg@example.com"},
		Worker:        nickclaim.WorkerHealth{Running: true, ConsecutiveFailures: 1, LastError: "tls: first record does not look like a TLS handshake"},
		PendingClaims: 2,
	}}
	rr := callInternal(t, NewInternalHandler(rt, "s3cret", nil), "GET", "/internal/nick-claims/status", "s3cret", "")
	require.Equal(t, stdhttp.StatusOK, rr.Code)
	assert.JSONEq(t, `{
		"enabled": true,
		"email_domain": "example.com",
		"inbound": {"host":"pop3.example.com","port":995,"tls":true,"user":"reg@example.com"},
		"worker": {"running":true,"last_drain_at":null,"last_ok_at":null,
		           "last_error":"tls: first record does not look like a TLS handshake","consecutive_failures":1},
		"pending_claims": 2
	}`, rr.Body.String())
}

func TestInternal_NickClaimTest(t *testing.T) {
	cur := nickclaim.WorkerConfig{Host: "pop3.example.com", Port: 995, UseTLS: true, User: "reg@example.com", Password: "stored"}
	rt := &stubRuntime{settings: nickclaim.Settings{Inbound: cur}}
	h := NewInternalHandler(rt, "s3cret", nil)

	// Empty body: the config in use.
	rr := callInternal(t, h, "POST", "/internal/nick-claims/test", "s3cret", "")
	require.Equal(t, stdhttp.StatusOK, rr.Code)
	assert.JSONEq(t, `{"ok":true,"message":"ok","messages":1}`, rr.Body.String())
	assert.Equal(t, cur, *rt.tested)

	// Unsaved values for the same host reuse the stored password.
	rr = callInternal(t, h, "POST", "/internal/nick-claims/test", "s3cret", `{"inbound":{"port":1995,"tls":false,"user":"other@example.com"}}`)
	require.Equal(t, stdhttp.StatusOK, rr.Code)
	assert.Equal(t, nickclaim.WorkerConfig{Host: "pop3.example.com", Port: 1995, UseTLS: false, User: "other@example.com", Password: "stored"}, *rt.tested)

	// Another host: the stored password is not sent there.
	rr = callInternal(t, h, "POST", "/internal/nick-claims/test", "s3cret", `{"inbound":{"host":"evil.example.net"}}`)
	require.Equal(t, stdhttp.StatusOK, rr.Code)
	assert.Equal(t, "evil.example.net", rt.tested.Host)
	assert.Empty(t, rt.tested.Password)

	// ...unless the request brings its own.
	rr = callInternal(t, h, "POST", "/internal/nick-claims/test", "s3cret", `{"inbound":{"host":"new.example.com","password":"typed"}}`)
	require.Equal(t, stdhttp.StatusOK, rr.Code)
	assert.Equal(t, "typed", rt.tested.Password)
	assert.NotContains(t, rr.Body.String(), "typed")

	for _, bad := range []string{`{"inbound":{"protocol":"imap"}}`, `{"inbound":{"port":0}}`, `nope`} {
		rr = callInternal(t, h, "POST", "/internal/nick-claims/test", "s3cret", bad)
		assert.Equal(t, stdhttp.StatusBadRequest, rr.Code, bad)
	}
}
