package http

import (
	stdhttp "net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
)

// recordingAuth is a stand-in for middleware.RequireAuth that simply records
// every request that passed through it, then calls the next handler. Lets us
// assert which routes are auth-gated without needing real JWT verification.
func recordingAuth(hits *[]string) func(stdhttp.Handler) stdhttp.Handler {
	return func(next stdhttp.Handler) stdhttp.Handler {
		return stdhttp.HandlerFunc(func(w stdhttp.ResponseWriter, r *stdhttp.Request) {
			*hits = append(*hits, r.Method+" "+r.URL.Path)
			next.ServeHTTP(w, r)
		})
	}
}

// Builds a publicMux + protectedMux with stub handlers whose names we can
// assert on, plus a recording auth wrapper. Returns the router and the auth
// hits slice so each test can introspect.
func newTestRouter() (*stdhttp.ServeMux, *[]string) {
	publicMux := stdhttp.NewServeMux()
	publicMux.HandleFunc("GET /health", func(w stdhttp.ResponseWriter, _ *stdhttp.Request) {
		_, _ = w.Write([]byte("public:health"))
	})
	publicMux.HandleFunc("GET /servers", func(w stdhttp.ResponseWriter, _ *stdhttp.Request) {
		_, _ = w.Write([]byte("public:list"))
	})
	publicMux.HandleFunc("GET /servers/{id}", func(w stdhttp.ResponseWriter, _ *stdhttp.Request) {
		_, _ = w.Write([]byte("public:get"))
	})

	protectedMux := stdhttp.NewServeMux()
	protectedMux.HandleFunc("POST /servers", func(w stdhttp.ResponseWriter, _ *stdhttp.Request) {
		_, _ = w.Write([]byte("protected:create"))
	})
	protectedMux.HandleFunc("GET /me", func(w stdhttp.ResponseWriter, _ *stdhttp.Request) {
		_, _ = w.Write([]byte("protected:me"))
	})

	hits := []string{}
	router := buildRouter(publicMux, protectedMux, recordingAuth(&hits))
	return router, &hits
}

func TestBuildRouter_PublicDirectoryRoutesBypassAuth(t *testing.T) {
	router, hits := newTestRouter()

	// GET /servers — anonymous directory browse.
	rr := httptest.NewRecorder()
	router.ServeHTTP(rr, httptest.NewRequest("GET", "/servers", nil))
	assert.Equal(t, stdhttp.StatusOK, rr.Code)
	assert.Equal(t, "public:list", rr.Body.String())

	// GET /servers/{id} — anonymous directory detail.
	rr = httptest.NewRecorder()
	router.ServeHTTP(rr, httptest.NewRequest("GET", "/servers/abc-123", nil))
	assert.Equal(t, stdhttp.StatusOK, rr.Code)
	assert.Equal(t, "public:get", rr.Body.String())

	// GET /health — bypasses auth.
	rr = httptest.NewRecorder()
	router.ServeHTTP(rr, httptest.NewRequest("GET", "/health", nil))
	assert.Equal(t, stdhttp.StatusOK, rr.Code)
	assert.Equal(t, "public:health", rr.Body.String())

	// Most important assertion: none of the public routes ran the auth
	// middleware. A regression that re-gates the directory would surface here.
	assert.Empty(t, *hits, "public routes must not pass through the auth middleware")
}

func TestBuildRouter_ServerCreateGoesThroughAuth(t *testing.T) {
	router, hits := newTestRouter()

	rr := httptest.NewRecorder()
	req := httptest.NewRequest("POST", "/servers", strings.NewReader(`{}`))
	router.ServeHTTP(rr, req)

	// Auth ran before the protected handler dispatched.
	assert.Equal(t, []string{"POST /servers"}, *hits)
	assert.Equal(t, stdhttp.StatusOK, rr.Code)
	assert.Equal(t, "protected:create", rr.Body.String())
}

func TestBuildRouter_CatchAllRoutesGoThroughAuth(t *testing.T) {
	router, hits := newTestRouter()

	rr := httptest.NewRecorder()
	router.ServeHTTP(rr, httptest.NewRequest("GET", "/me", nil))

	assert.Equal(t, []string{"GET /me"}, *hits)
	assert.Equal(t, stdhttp.StatusOK, rr.Code)
	assert.Equal(t, "protected:me", rr.Body.String())
}

func TestBuildRouter_UnknownPathStillHitsAuth(t *testing.T) {
	// An unauthenticated request to a path that doesn't exist must NOT leak
	// the existence of routes — it goes through auth (which would 401 in
	// production) before reaching the protected mux's 404.
	router, hits := newTestRouter()

	rr := httptest.NewRecorder()
	router.ServeHTTP(rr, httptest.NewRequest("GET", "/does-not-exist", nil))

	assert.Equal(t, []string{"GET /does-not-exist"}, *hits)
	assert.Equal(t, stdhttp.StatusNotFound, rr.Code)
}
