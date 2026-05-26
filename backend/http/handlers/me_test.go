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
	"github.com/boson-chat/boson/backend/internal/services/user"

	"github.com/google/uuid"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// callMe builds a mux with the handler, injects the principal into the
// request context, and returns the recorded response.
func callMe(t *testing.T, svc user.UserServiceImpl, principal middleware.Principal, method, path, body string) *httptest.ResponseRecorder {
	t.Helper()
	mux := stdhttp.NewServeMux()
	NewMeHandler(svc).Register(mux)

	req := httptest.NewRequest(method, path, strings.NewReader(body))
	if body != "" {
		req.Header.Set("Content-Type", "application/json")
	}
	req = req.WithContext(middleware.WithUser(context.Background(), principal))
	rr := httptest.NewRecorder()
	mux.ServeHTTP(rr, req)
	return rr
}

func TestMeHandler_Get_Found(t *testing.T) {
	uid := uuid.New()
	want := &user.User{ID: uid, Handle: "alice"}
	svc := &stubUserService{
		getByID: func(_ context.Context, id uuid.UUID) (*user.User, error) {
			assert.Equal(t, uid, id)
			return want, nil
		},
	}

	rr := callMe(t, svc, middleware.Principal{UserID: uid}, "GET", "/me", "")

	assert.Equal(t, stdhttp.StatusOK, rr.Code)
	var got user.User
	require.NoError(t, json.NewDecoder(rr.Body).Decode(&got))
	assert.Equal(t, "alice", got.Handle)
}

func TestMeHandler_Get_NotFound(t *testing.T) {
	svc := &stubUserService{
		getByID: func(_ context.Context, _ uuid.UUID) (*user.User, error) { return nil, user.ErrNotFound },
	}
	rr := callMe(t, svc, middleware.Principal{UserID: uuid.New()}, "GET", "/me", "")
	assert.Equal(t, stdhttp.StatusNotFound, rr.Code)
	assert.Contains(t, rr.Body.String(), "needs_setup")
}

func TestMeHandler_Get_InternalError(t *testing.T) {
	svc := &stubUserService{
		getByID: func(_ context.Context, _ uuid.UUID) (*user.User, error) { return nil, errors.New("db down") },
	}
	rr := callMe(t, svc, middleware.Principal{UserID: uuid.New()}, "GET", "/me", "")
	assert.Equal(t, stdhttp.StatusInternalServerError, rr.Code)
}

func TestMeHandler_Post_Success(t *testing.T) {
	uid := uuid.New()
	want := &user.User{ID: uid, Handle: "alice"}
	svc := &stubUserService{
		create: func(_ context.Context, in user.CreateUserInput) (*user.User, error) {
			assert.Equal(t, uid, in.ID)
			assert.Equal(t, "alice", in.Handle)
			assert.Equal(t, []byte("abcd"), in.EncryptedUserSecret)
			return want, nil
		},
	}
	rr := callMe(t, svc, middleware.Principal{UserID: uid}, "POST", "/me",
		`{"handle":"alice","encrypted_user_secret":"YWJjZA=="}`)
	assert.Equal(t, stdhttp.StatusCreated, rr.Code)
}

func TestMeHandler_Post_InvalidJSON(t *testing.T) {
	rr := callMe(t, &stubUserService{}, middleware.Principal{UserID: uuid.New()},
		"POST", "/me", `not json`)
	assert.Equal(t, stdhttp.StatusBadRequest, rr.Code)
}

func TestMeHandler_Post_BadBase64(t *testing.T) {
	rr := callMe(t, &stubUserService{}, middleware.Principal{UserID: uuid.New()},
		"POST", "/me", `{"handle":"alice","encrypted_user_secret":"not-base64!@#"}`)
	assert.Equal(t, stdhttp.StatusBadRequest, rr.Code)
	assert.Contains(t, rr.Body.String(), "base64")
}

func TestMeHandler_Post_EmptySecret(t *testing.T) {
	rr := callMe(t, &stubUserService{}, middleware.Principal{UserID: uuid.New()},
		"POST", "/me", `{"handle":"alice","encrypted_user_secret":""}`)
	assert.Equal(t, stdhttp.StatusBadRequest, rr.Code)
}

func TestMeHandler_Post_HandleInvalid(t *testing.T) {
	svc := &stubUserService{
		create: func(_ context.Context, _ user.CreateUserInput) (*user.User, error) {
			return nil, user.ErrHandleInvalid
		},
	}
	rr := callMe(t, svc, middleware.Principal{UserID: uuid.New()},
		"POST", "/me", `{"handle":"ab","encrypted_user_secret":"YWJjZA=="}`)
	assert.Equal(t, stdhttp.StatusBadRequest, rr.Code)
}

func TestMeHandler_Post_HandleTaken(t *testing.T) {
	svc := &stubUserService{
		create: func(_ context.Context, _ user.CreateUserInput) (*user.User, error) {
			return nil, user.ErrHandleTaken
		},
	}
	rr := callMe(t, svc, middleware.Principal{UserID: uuid.New()},
		"POST", "/me", `{"handle":"alice","encrypted_user_secret":"YWJjZA=="}`)
	assert.Equal(t, stdhttp.StatusConflict, rr.Code)
}

func TestMeHandler_Post_AlreadyExists(t *testing.T) {
	svc := &stubUserService{
		create: func(_ context.Context, _ user.CreateUserInput) (*user.User, error) {
			return nil, user.ErrAlreadyExists
		},
	}
	rr := callMe(t, svc, middleware.Principal{UserID: uuid.New()},
		"POST", "/me", `{"handle":"alice","encrypted_user_secret":"YWJjZA=="}`)
	assert.Equal(t, stdhttp.StatusConflict, rr.Code)
}

func TestMeHandler_Post_InternalError(t *testing.T) {
	svc := &stubUserService{
		create: func(_ context.Context, _ user.CreateUserInput) (*user.User, error) {
			return nil, errors.New("db down")
		},
	}
	rr := callMe(t, svc, middleware.Principal{UserID: uuid.New()},
		"POST", "/me", `{"handle":"alice","encrypted_user_secret":"YWJjZA=="}`)
	assert.Equal(t, stdhttp.StatusInternalServerError, rr.Code)
}

func TestMeHandler_Delete_Success(t *testing.T) {
	uid := uuid.New()
	svc := &stubUserService{}
	rr := callMe(t, svc, middleware.Principal{UserID: uid}, "DELETE", "/me", "")
	assert.Equal(t, stdhttp.StatusNoContent, rr.Code)
	assert.Equal(t, []uuid.UUID{uid}, svc.deleteArgs)
}

// Deleting an already-gone row is idempotent — 204 either way so the client
// can call /me DELETE without first checking whether it exists.
func TestMeHandler_Delete_NotFound(t *testing.T) {
	svc := &stubUserService{
		deleteFn: func(_ context.Context, _ uuid.UUID) error { return user.ErrNotFound },
	}
	rr := callMe(t, svc, middleware.Principal{UserID: uuid.New()}, "DELETE", "/me", "")
	assert.Equal(t, stdhttp.StatusNoContent, rr.Code)
}

func TestMeHandler_Delete_InternalError(t *testing.T) {
	svc := &stubUserService{
		deleteFn: func(_ context.Context, _ uuid.UUID) error { return errors.New("db down") },
	}
	rr := callMe(t, svc, middleware.Principal{UserID: uuid.New()}, "DELETE", "/me", "")
	assert.Equal(t, stdhttp.StatusInternalServerError, rr.Code)
}
