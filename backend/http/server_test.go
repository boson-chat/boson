package http

import (
	stdhttp "net/http"
	"net/http/httptest"
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

	protectedMux := stdhttp.NewServeMux()
	protectedMux.HandleFunc("GET /me", func(w stdhttp.ResponseWriter, _ *stdhttp.Request) {
		_, _ = w.Write([]byte("protected:me"))
	})

	hits := []string{}
	router := buildRouter(publicMux, protectedMux, recordingAuth(&hits))
	return router, &hits
}

func TestBuildRouter_HealthBypassesAuth(t *testing.T) {
	router, hits := newTestRouter()

	rr := httptest.NewRecorder()
	router.ServeHTTP(rr, httptest.NewRequest("GET", "/health", nil))
	assert.Equal(t, stdhttp.StatusOK, rr.Code)
	assert.Equal(t, "public:health", rr.Body.String())
	assert.Empty(t, *hits, "/health must not pass through the auth middleware")
}

func TestBuildRouter_RemovedDirectoryRoutesHitAuth(t *testing.T) {
	// The directory moved to its own service; /servers is no longer a
	// public route here and falls through to auth like any unknown path.
	router, hits := newTestRouter()

	rr := httptest.NewRecorder()
	router.ServeHTTP(rr, httptest.NewRequest("GET", "/servers", nil))

	assert.Equal(t, []string{"GET /servers"}, *hits)
	assert.Equal(t, stdhttp.StatusNotFound, rr.Code)
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
