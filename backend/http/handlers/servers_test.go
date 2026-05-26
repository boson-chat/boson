package handlers

import (
	"context"
	"encoding/json"
	"errors"
	stdhttp "net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/boson-chat/boson/backend/http/middleware"
	"github.com/boson-chat/boson/backend/internal/services/server"

	"github.com/google/uuid"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func callServers(t *testing.T, svc server.ServerServiceImpl, principal middleware.Principal, method, path, body string) *httptest.ResponseRecorder {
	t.Helper()
	mux := stdhttp.NewServeMux()
	NewServerHandler(svc).Register(mux)

	req := httptest.NewRequest(method, path, strings.NewReader(body))
	if body != "" {
		req.Header.Set("Content-Type", "application/json")
	}
	req = req.WithContext(middleware.WithUser(context.Background(), principal))
	rr := httptest.NewRecorder()
	mux.ServeHTTP(rr, req)
	return rr
}

func TestServerHandler_List_PassesQueryParams(t *testing.T) {
	want := []*server.Server{{Name: "Libera"}}
	svc := &stubServerService{
		list: func(_ context.Context, _ server.ListFilter) ([]*server.Server, error) {
			return want, nil
		},
	}

	rr := callServers(t, svc, middleware.Principal{UserID: uuid.New()},
		"GET", "/servers?q=foss&lang=en&nsfw=true&sort=newest&limit=10&offset=5", "")

	assert.Equal(t, stdhttp.StatusOK, rr.Code)
	require.Len(t, svc.listArgs, 1)
	got := svc.listArgs[0]
	assert.Equal(t, "foss", got.Query)
	assert.Equal(t, "en", got.Language)
	assert.True(t, got.IncludeNSFW)
	assert.Equal(t, "newest", got.Sort)
	assert.Equal(t, 10, got.Limit)
	assert.Equal(t, 5, got.Offset)

	var body struct {
		Servers []*server.Server `json:"servers"`
		Count   int              `json:"count"`
	}
	require.NoError(t, json.NewDecoder(rr.Body).Decode(&body))
	assert.Equal(t, 1, body.Count)
}

func TestServerHandler_List_InternalError(t *testing.T) {
	svc := &stubServerService{
		list: func(_ context.Context, _ server.ListFilter) ([]*server.Server, error) {
			return nil, errors.New("db down")
		},
	}
	rr := callServers(t, svc, middleware.Principal{UserID: uuid.New()},
		"GET", "/servers", "")
	assert.Equal(t, stdhttp.StatusInternalServerError, rr.Code)
}

func TestServerHandler_Get_Found(t *testing.T) {
	id := uuid.New()
	want := &server.Server{ID: id, Name: "Libera"}
	svc := &stubServerService{
		getByID: func(_ context.Context, gotID uuid.UUID) (*server.Server, error) {
			assert.Equal(t, id, gotID)
			return want, nil
		},
	}
	rr := callServers(t, svc, middleware.Principal{UserID: uuid.New()},
		"GET", "/servers/"+id.String(), "")
	assert.Equal(t, stdhttp.StatusOK, rr.Code)
}

func TestServerHandler_Get_NotFound(t *testing.T) {
	svc := &stubServerService{
		getByID: func(_ context.Context, _ uuid.UUID) (*server.Server, error) { return nil, server.ErrNotFound },
	}
	rr := callServers(t, svc, middleware.Principal{UserID: uuid.New()},
		"GET", "/servers/"+uuid.NewString(), "")
	assert.Equal(t, stdhttp.StatusNotFound, rr.Code)
}

func TestServerHandler_Get_BadID(t *testing.T) {
	rr := callServers(t, &stubServerService{}, middleware.Principal{UserID: uuid.New()},
		"GET", "/servers/not-a-uuid", "")
	assert.Equal(t, stdhttp.StatusBadRequest, rr.Code)
}

func TestServerHandler_Post_Success(t *testing.T) {
	registeredBy := uuid.New()
	want := &server.Server{ID: uuid.New(), Name: "Libera"}
	svc := &stubServerService{
		create: func(_ context.Context, gotRegisteredBy uuid.UUID, in server.CreateInput) (*server.Server, error) {
			assert.Equal(t, registeredBy, gotRegisteredBy)
			assert.Equal(t, "irc.libera.chat", in.Hostname)
			assert.Equal(t, 6697, in.Port)
			assert.True(t, in.TLS)
			assert.Equal(t, "Libera", in.Name)
			assert.Equal(t, []string{"foss"}, in.Tags)
			return want, nil
		},
	}
	body := `{"hostname":"irc.libera.chat","port":6697,"tls":true,"name":"Libera","tags":["foss"]}`
	rr := callServers(t, svc, middleware.Principal{UserID: registeredBy},
		"POST", "/servers", body)
	assert.Equal(t, stdhttp.StatusCreated, rr.Code)
}

func TestServerHandler_Post_DefaultTLS(t *testing.T) {
	svc := &stubServerService{
		create: func(_ context.Context, _ uuid.UUID, in server.CreateInput) (*server.Server, error) {
			assert.True(t, in.TLS, "TLS defaults to true when omitted")
			return &server.Server{}, nil
		},
	}
	rr := callServers(t, svc, middleware.Principal{UserID: uuid.New()},
		"POST", "/servers", `{"hostname":"irc","port":6697,"name":"Test"}`)
	assert.Equal(t, stdhttp.StatusCreated, rr.Code)
}

func TestServerHandler_Post_TLSExplicitFalse(t *testing.T) {
	svc := &stubServerService{
		create: func(_ context.Context, _ uuid.UUID, in server.CreateInput) (*server.Server, error) {
			assert.False(t, in.TLS, "explicit false should be honored")
			return &server.Server{}, nil
		},
	}
	rr := callServers(t, svc, middleware.Principal{UserID: uuid.New()},
		"POST", "/servers", `{"hostname":"irc","port":6667,"tls":false,"name":"Test"}`)
	assert.Equal(t, stdhttp.StatusCreated, rr.Code)
}

func TestServerHandler_Post_InvalidInput(t *testing.T) {
	svc := &stubServerService{
		create: func(_ context.Context, _ uuid.UUID, _ server.CreateInput) (*server.Server, error) {
			return nil, server.ErrInvalidInput
		},
	}
	rr := callServers(t, svc, middleware.Principal{UserID: uuid.New()},
		"POST", "/servers", `{"hostname":"","port":0,"name":""}`)
	assert.Equal(t, stdhttp.StatusBadRequest, rr.Code)
}

func TestServerHandler_Post_InvalidJSON(t *testing.T) {
	rr := callServers(t, &stubServerService{}, middleware.Principal{UserID: uuid.New()},
		"POST", "/servers", `not json`)
	assert.Equal(t, stdhttp.StatusBadRequest, rr.Code)
}

func TestServerHandler_Post_InternalError(t *testing.T) {
	svc := &stubServerService{
		create: func(_ context.Context, _ uuid.UUID, _ server.CreateInput) (*server.Server, error) {
			return nil, errors.New("db down")
		},
	}
	rr := callServers(t, svc, middleware.Principal{UserID: uuid.New()},
		"POST", "/servers", `{"hostname":"irc","port":6697,"name":"Test"}`)
	assert.Equal(t, stdhttp.StatusInternalServerError, rr.Code)
}

// The public mux only mounts the read-only directory routes — anyone, including
// guests with no Supabase session, can browse the server list. POST falls
// through to the catch-all auth-wrapped mux in production; mounted alone here
// it should 405 because the public mux has no POST handler.
func TestServerHandler_RegisterPublic_MountsReadOnlyRoutes(t *testing.T) {
	svc := &stubServerService{
		list: func(_ context.Context, _ server.ListFilter) ([]*server.Server, error) {
			return []*server.Server{{Name: "Libera"}}, nil
		},
		getByID: func(_ context.Context, _ uuid.UUID) (*server.Server, error) {
			return &server.Server{Name: "Libera"}, nil
		},
	}
	mux := stdhttp.NewServeMux()
	NewServerHandler(svc).RegisterPublic(mux)

	// GET /servers and GET /servers/{id} are served without any auth context.
	getReq := httptest.NewRequest("GET", "/servers", nil)
	getRR := httptest.NewRecorder()
	mux.ServeHTTP(getRR, getReq)
	assert.Equal(t, stdhttp.StatusOK, getRR.Code)

	getOneReq := httptest.NewRequest("GET", "/servers/"+uuid.NewString(), nil)
	getOneRR := httptest.NewRecorder()
	mux.ServeHTTP(getOneRR, getOneReq)
	assert.Equal(t, stdhttp.StatusOK, getOneRR.Code)

	// POST /servers is NOT on the public mux — confirms the create route did
	// not accidentally leak into the unauthenticated surface.
	postReq := httptest.NewRequest("POST", "/servers",
		strings.NewReader(`{"hostname":"irc","port":6697,"name":"Test"}`))
	postReq.Header.Set("Content-Type", "application/json")
	postRR := httptest.NewRecorder()
	mux.ServeHTTP(postRR, postReq)
	assert.Equal(t, stdhttp.StatusMethodNotAllowed, postRR.Code,
		"POST /servers must not be reachable on the public mux")
}

// The protected mux only mounts the write routes that require an authenticated
// principal. GETs are served from the public mux in production, so they should
// not appear here at all.
func TestServerHandler_RegisterProtected_MountsWriteRoutesOnly(t *testing.T) {
	svc := &stubServerService{
		create: func(_ context.Context, _ uuid.UUID, _ server.CreateInput) (*server.Server, error) {
			return &server.Server{}, nil
		},
	}
	mux := stdhttp.NewServeMux()
	NewServerHandler(svc).RegisterProtected(mux)

	postReq := httptest.NewRequest("POST", "/servers",
		strings.NewReader(`{"hostname":"irc","port":6697,"name":"Test"}`))
	postReq.Header.Set("Content-Type", "application/json")
	postReq = postReq.WithContext(middleware.WithUser(context.Background(),
		middleware.Principal{UserID: uuid.New()}))
	postRR := httptest.NewRecorder()
	mux.ServeHTTP(postRR, postReq)
	assert.Equal(t, stdhttp.StatusCreated, postRR.Code)

	getRR := httptest.NewRecorder()
	mux.ServeHTTP(getRR, httptest.NewRequest("GET", "/servers", nil))
	assert.Equal(t, stdhttp.StatusMethodNotAllowed, getRR.Code,
		"GET /servers must not be on the protected mux — it lives on the public one")
}
