package handlers

import (
	"context"
	stdhttp "net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/boson-chat/boson/backend/http/middleware"
	"github.com/boson-chat/boson/backend/internal/services/avatar"
	"github.com/boson-chat/boson/backend/internal/services/server"

	"github.com/google/uuid"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func callServerImg(t *testing.T, svc server.ServerServiceImpl, av avatar.ServiceImpl, p middleware.Principal, method, path, body string) *httptest.ResponseRecorder {
	t.Helper()
	mux := stdhttp.NewServeMux()
	NewServerHandler(svc, av).Register(mux)
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	req.Header.Set("Content-Type", "image/png")
	req = req.WithContext(middleware.WithUser(context.Background(), p))
	rr := httptest.NewRecorder()
	mux.ServeHTTP(rr, req)
	return rr
}

func TestUploadServerIcon_Success(t *testing.T) {
	owner := uuid.New()
	id := uuid.New()
	key := "server-icons/" + id.String() + "-abc.png"
	var gotWhich string
	var gotKey *string
	svc := &stubServerService{
		getByID: func(_ context.Context, _ uuid.UUID) (*server.Server, error) {
			return &server.Server{ID: id, RegisteredBy: &owner, VerificationStatus: "verified"}, nil
		},
		setImageKey: func(_ context.Context, _, _ uuid.UUID, which string, k *string) (*server.Server, error) {
			gotWhich, gotKey = which, k
			return &server.Server{ID: id, RegisteredBy: &owner, VerificationStatus: "verified", IconStorageKey: k}, nil
		},
	}
	av := &fakeAvatarService{configured: true, processKey: key}
	rr := callServerImg(t, svc, av, middleware.Principal{UserID: owner}, "POST", "/servers/"+id.String()+"/icon", "rawpng")
	require.Equal(t, stdhttp.StatusOK, rr.Code)
	assert.Equal(t, "icon", gotWhich)
	require.NotNil(t, gotKey)
	assert.Equal(t, key, *gotKey)
	assert.Contains(t, rr.Body.String(), "https://cdn.boson.chat/"+key) // enriched icon_url
}

func TestUploadServerBanner_NotOwner(t *testing.T) {
	owner := uuid.New()
	other := uuid.New()
	id := uuid.New()
	processed := false
	svc := &stubServerService{
		getByID: func(_ context.Context, _ uuid.UUID) (*server.Server, error) {
			return &server.Server{ID: id, RegisteredBy: &owner}, nil
		},
	}
	av := &fakeAvatarService{configured: true, processKey: "x"}
	_ = processed
	rr := callServerImg(t, svc, av, middleware.Principal{UserID: other}, "POST", "/servers/"+id.String()+"/banner", "rawpng")
	assert.Equal(t, stdhttp.StatusForbidden, rr.Code)
}

func TestUploadServerIcon_NotConfigured(t *testing.T) {
	id := uuid.New()
	rr := callServerImg(t, &stubServerService{}, &fakeAvatarService{configured: false}, middleware.Principal{UserID: uuid.New()}, "POST", "/servers/"+id.String()+"/icon", "x")
	assert.Equal(t, stdhttp.StatusServiceUnavailable, rr.Code)
}

func TestUploadServerIcon_TooLarge(t *testing.T) {
	owner := uuid.New()
	id := uuid.New()
	svc := &stubServerService{getByID: func(_ context.Context, _ uuid.UUID) (*server.Server, error) {
		return &server.Server{ID: id, RegisteredBy: &owner}, nil
	}}
	big := strings.Repeat("x", avatar.MaxUploadBytes+1)
	rr := callServerImg(t, svc, &fakeAvatarService{configured: true}, middleware.Principal{UserID: owner}, "POST", "/servers/"+id.String()+"/icon", big)
	assert.Equal(t, stdhttp.StatusRequestEntityTooLarge, rr.Code)
}

func TestUploadServerIcon_UnsupportedImage(t *testing.T) {
	owner := uuid.New()
	id := uuid.New()
	svc := &stubServerService{getByID: func(_ context.Context, _ uuid.UUID) (*server.Server, error) {
		return &server.Server{ID: id, RegisteredBy: &owner}, nil
	}}
	av := &fakeAvatarService{configured: true, processErr: avatar.ErrUnsupportedImage}
	rr := callServerImg(t, svc, av, middleware.Principal{UserID: owner}, "POST", "/servers/"+id.String()+"/icon", "notpng")
	assert.Equal(t, stdhttp.StatusBadRequest, rr.Code)
}

func TestDeleteServerBanner_RemovesAndClears(t *testing.T) {
	owner := uuid.New()
	id := uuid.New()
	old := "server-banners/" + id.String() + "-old.png"
	var clearedNil bool
	svc := &stubServerService{
		getByID: func(_ context.Context, _ uuid.UUID) (*server.Server, error) {
			return &server.Server{ID: id, RegisteredBy: &owner, BannerStorageKey: &old}, nil
		},
		setImageKey: func(_ context.Context, _, _ uuid.UUID, which string, k *string) (*server.Server, error) {
			clearedNil = (which == "banner" && k == nil)
			return &server.Server{ID: id, RegisteredBy: &owner}, nil
		},
	}
	av := &fakeAvatarService{configured: true}
	rr := callServerImg(t, svc, av, middleware.Principal{UserID: owner}, "DELETE", "/servers/"+id.String()+"/banner", "")
	require.Equal(t, stdhttp.StatusOK, rr.Code)
	assert.True(t, clearedNil, "banner key cleared to nil")
	assert.Contains(t, av.removed, old) // old object deleted from R2
}

func TestGetServer_IncludesImageURLs(t *testing.T) {
	id := uuid.New()
	icon := "server-icons/" + id.String() + "-x.png"
	svc := &stubServerService{getByID: func(_ context.Context, _ uuid.UUID) (*server.Server, error) {
		return &server.Server{ID: id, Name: "Libera", IconStorageKey: &icon}, nil
	}}
	av := &fakeAvatarService{configured: true}
	rr := callServerImg(t, svc, av, middleware.Principal{UserID: uuid.New()}, "GET", "/servers/"+id.String(), "")
	require.Equal(t, stdhttp.StatusOK, rr.Code)
	assert.Contains(t, rr.Body.String(), "https://cdn.boson.chat/"+icon)
}
