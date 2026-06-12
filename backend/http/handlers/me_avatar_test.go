package handlers

import (
	"context"
	"net/http/httptest"
	stdhttp "net/http"
	"strings"
	"testing"

	"github.com/boson-chat/boson/backend/http/middleware"
	"github.com/boson-chat/boson/backend/internal/services/avatar"
	"github.com/boson-chat/boson/backend/internal/services/user"

	"github.com/google/uuid"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

type fakeAvatarService struct {
	configured bool
	processKey string
	processErr error
	removed    []string
}

func (f *fakeAvatarService) Configured() bool { return f.configured }
func (f *fakeAvatarService) Process(_ context.Context, _ uuid.UUID, _ []byte, _ string) (string, error) {
	return f.processKey, f.processErr
}
func (f *fakeAvatarService) Remove(_ context.Context, key string) error {
	f.removed = append(f.removed, key)
	return nil
}
func (f *fakeAvatarService) URLFor(key string) string {
	if key == "" {
		return ""
	}
	return "https://cdn.boson.chat/" + key
}

func callAvatar(t *testing.T, usr user.UserServiceImpl, av avatar.ServiceImpl, p middleware.Principal, method, body string) *httptest.ResponseRecorder {
	t.Helper()
	mux := stdhttp.NewServeMux()
	NewMeHandler(usr, av).Register(mux)
	req := httptest.NewRequest(method, "/me/avatar", strings.NewReader(body))
	req.Header.Set("Content-Type", "image/png")
	req = req.WithContext(middleware.WithUser(context.Background(), p))
	rr := httptest.NewRecorder()
	mux.ServeHTTP(rr, req)
	return rr
}

func TestUploadAvatar_Success(t *testing.T) {
	uid := uuid.New()
	var setKey *string
	usr := &stubUserService{
		getByID: func(_ context.Context, _ uuid.UUID) (*user.User, error) {
			return &user.User{ID: uid, Handle: "alice"}, nil
		},
		setAvatarKey: func(_ context.Context, _ uuid.UUID, key *string) (*user.User, error) {
			setKey = key
			return &user.User{ID: uid, Handle: "alice", AvatarStorageKey: key}, nil
		},
	}
	av := &fakeAvatarService{configured: true, processKey: "avatars/" + uid.String() + "-abc.png"}

	rr := callAvatar(t, usr, av, middleware.Principal{UserID: uid}, "POST", "rawimagebytes")
	require.Equal(t, stdhttp.StatusOK, rr.Code)
	require.NotNil(t, setKey)
	assert.Equal(t, av.processKey, *setKey)
	assert.Contains(t, rr.Body.String(), "https://cdn.boson.chat/avatars/")
}

func TestUploadAvatar_NotConfigured(t *testing.T) {
	rr := callAvatar(t, &stubUserService{}, &fakeAvatarService{configured: false}, middleware.Principal{UserID: uuid.New()}, "POST", "x")
	assert.Equal(t, stdhttp.StatusServiceUnavailable, rr.Code)
}

func TestUploadAvatar_NilService(t *testing.T) {
	rr := callAvatar(t, &stubUserService{}, nil, middleware.Principal{UserID: uuid.New()}, "POST", "x")
	assert.Equal(t, stdhttp.StatusServiceUnavailable, rr.Code)
}

func TestUploadAvatar_UnsupportedImage(t *testing.T) {
	uid := uuid.New()
	usr := &stubUserService{getByID: func(_ context.Context, _ uuid.UUID) (*user.User, error) {
		return &user.User{ID: uid}, nil
	}}
	av := &fakeAvatarService{configured: true, processErr: avatar.ErrUnsupportedImage}
	rr := callAvatar(t, usr, av, middleware.Principal{UserID: uid}, "POST", "notanimage")
	assert.Equal(t, stdhttp.StatusBadRequest, rr.Code)
}

func TestUploadAvatar_TooLarge(t *testing.T) {
	uid := uuid.New()
	usr := &stubUserService{getByID: func(_ context.Context, _ uuid.UUID) (*user.User, error) {
		return &user.User{ID: uid}, nil
	}}
	av := &fakeAvatarService{configured: true}
	big := strings.Repeat("x", avatar.MaxUploadBytes+1)
	rr := callAvatar(t, usr, av, middleware.Principal{UserID: uid}, "POST", big)
	assert.Equal(t, stdhttp.StatusRequestEntityTooLarge, rr.Code)
}

func TestDeleteAvatar_RemovesAndClears(t *testing.T) {
	uid := uuid.New()
	prev := "avatars/" + uid.String() + "-old.png"
	var setKey *string
	cleared := false
	usr := &stubUserService{
		getByID: func(_ context.Context, _ uuid.UUID) (*user.User, error) {
			return &user.User{ID: uid, AvatarStorageKey: &prev}, nil
		},
		setAvatarKey: func(_ context.Context, _ uuid.UUID, key *string) (*user.User, error) {
			setKey = key
			cleared = key == nil
			return &user.User{ID: uid}, nil
		},
	}
	av := &fakeAvatarService{configured: true}
	rr := callAvatar(t, usr, av, middleware.Principal{UserID: uid}, "DELETE", "")
	require.Equal(t, stdhttp.StatusOK, rr.Code)
	assert.Contains(t, av.removed, prev)
	assert.True(t, cleared, "avatar key cleared to nil")
	assert.Nil(t, setKey)
}
