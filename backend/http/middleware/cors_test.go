package middleware

import (
	stdhttp "net/http"
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func newCORSHandler(t *testing.T, origins string) stdhttp.Handler {
	t.Helper()
	next := stdhttp.HandlerFunc(func(w stdhttp.ResponseWriter, _ *stdhttp.Request) {
		w.WriteHeader(stdhttp.StatusOK)
		_, _ = w.Write([]byte("ok"))
	})
	return CORS(origins)(next)
}

func TestCORS_AllowedOriginEchoed(t *testing.T) {
	h := newCORSHandler(t, "http://localhost:5173,http://localhost:6173")

	req := httptest.NewRequest(stdhttp.MethodGet, "/foo", nil)
	req.Header.Set("Origin", "http://localhost:5173")
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, req)

	assert.Equal(t, stdhttp.StatusOK, rr.Code)
	assert.Equal(t, "http://localhost:5173", rr.Header().Get("Access-Control-Allow-Origin"))
	assert.Equal(t, "true", rr.Header().Get("Access-Control-Allow-Credentials"))
	assert.Equal(t, "Origin", rr.Header().Get("Vary"))
}

func TestCORS_DisallowedOriginNoEcho(t *testing.T) {
	h := newCORSHandler(t, "http://localhost:5173")

	req := httptest.NewRequest(stdhttp.MethodGet, "/foo", nil)
	req.Header.Set("Origin", "http://evil.example")
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, req)

	assert.Equal(t, stdhttp.StatusOK, rr.Code, "downstream still runs")
	assert.Empty(t, rr.Header().Get("Access-Control-Allow-Origin"), "must not echo back arbitrary origins")
}

func TestCORS_PreflightShortCircuits(t *testing.T) {
	called := false
	next := stdhttp.HandlerFunc(func(_ stdhttp.ResponseWriter, _ *stdhttp.Request) {
		called = true
	})
	h := CORS("http://localhost:5173")(next)

	req := httptest.NewRequest(stdhttp.MethodOptions, "/foo", nil)
	req.Header.Set("Origin", "http://localhost:5173")
	req.Header.Set("Access-Control-Request-Method", "POST")
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, req)

	assert.Equal(t, stdhttp.StatusNoContent, rr.Code)
	assert.False(t, called, "OPTIONS must not reach downstream handlers")
	assert.Equal(t, "http://localhost:5173", rr.Header().Get("Access-Control-Allow-Origin"))
	assert.Contains(t, rr.Header().Get("Access-Control-Allow-Methods"), "POST")
	assert.Contains(t, rr.Header().Get("Access-Control-Allow-Headers"), "Authorization")
}

func TestCORS_NoOriginHeaderPassthrough(t *testing.T) {
	h := newCORSHandler(t, "http://localhost:5173")

	req := httptest.NewRequest(stdhttp.MethodGet, "/foo", nil)
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, req)

	assert.Equal(t, stdhttp.StatusOK, rr.Code)
	assert.Empty(t, rr.Header().Get("Access-Control-Allow-Origin"))
}

func TestCORS_EmptyAllowedOrigins(t *testing.T) {
	h := newCORSHandler(t, "")

	req := httptest.NewRequest(stdhttp.MethodGet, "/foo", nil)
	req.Header.Set("Origin", "http://localhost:5173")
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, req)

	require.Equal(t, stdhttp.StatusOK, rr.Code)
	assert.Empty(t, rr.Header().Get("Access-Control-Allow-Origin"))
}
