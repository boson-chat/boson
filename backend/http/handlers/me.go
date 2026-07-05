package handlers

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	stdhttp "net/http"

	"github.com/boson-chat/boson/backend/http/middleware"
	"github.com/boson-chat/boson/backend/internal/services/avatar"
	"github.com/boson-chat/boson/backend/internal/services/user"
)

type MeHandler struct {
	Users user.UserServiceImpl
	// Avatar may be nil when R2 isn't configured (local dev); the avatar
	// routes 503 in that case and avatar_url is omitted from responses.
	Avatar avatar.ServiceImpl
}

func NewMeHandler(users user.UserServiceImpl, avatars avatar.ServiceImpl) *MeHandler {
	return &MeHandler{Users: users, Avatar: avatars}
}

func (h *MeHandler) Register(mux *stdhttp.ServeMux) {
	mux.HandleFunc("GET /me", h.get)
	mux.HandleFunc("POST /me", h.create)
	mux.HandleFunc("PATCH /me", h.patch)
	mux.HandleFunc("DELETE /me", h.delete)
	mux.HandleFunc("PUT /me/secret-wraps", h.updateSecretWraps)
	mux.HandleFunc("POST /me/avatar", h.uploadAvatar)
	mux.HandleFunc("DELETE /me/avatar", h.deleteAvatar)
}

// meResponse is the wire shape for the caller's own user — the User row plus a
// computed `avatar_url` (CDN URL derived from avatar_storage_key) so clients
// don't need to know the CDN base.
type meResponse struct {
	*user.User
	AvatarURL string `json:"avatar_url,omitempty"`
}

func (h *MeHandler) toResponse(u *user.User) meResponse {
	url := ""
	if u != nil && u.AvatarStorageKey != nil && h.Avatar != nil {
		url = h.Avatar.URLFor(*u.AvatarStorageKey)
	}
	return meResponse{User: u, AvatarURL: url}
}

func (h *MeHandler) get(w stdhttp.ResponseWriter, r *stdhttp.Request) {
	p := middleware.MustUser(r.Context())
	u, err := h.Users.GetByID(r.Context(), p.UserID)
	if errors.Is(err, user.ErrNotFound) {
		writeJSON(w, stdhttp.StatusNotFound, map[string]string{"status": "needs_setup"})
		return
	}
	if err != nil {
		writeInternalError(w, err)
		return
	}
	writeJSON(w, stdhttp.StatusOK, h.toResponse(u))
}

type createMeRequest struct {
	Handle                         string  `json:"handle"`
	DisplayName                    *string `json:"display_name,omitempty"`
	EncryptedUserSecretB64         string  `json:"encrypted_user_secret"`
	EncryptedUserSecretRecoveryB64 string  `json:"encrypted_user_secret_recovery,omitempty"`
}

func (h *MeHandler) create(w stdhttp.ResponseWriter, r *stdhttp.Request) {
	p := middleware.MustUser(r.Context())

	var req createMeRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, stdhttp.StatusBadRequest, "invalid json")
		return
	}

	secret, err := base64.StdEncoding.DecodeString(req.EncryptedUserSecretB64)
	if err != nil {
		writeError(w, stdhttp.StatusBadRequest, "encrypted_user_secret must be base64")
		return
	}
	if len(secret) == 0 {
		writeError(w, stdhttp.StatusBadRequest, "encrypted_user_secret is required")
		return
	}

	// Recovery wrap is optional on the wire so older clients keep working
	// during rollout; new clients always send it (the signup recovery-code
	// step). Empty string → nil → no recovery wrap stored yet.
	var recovery []byte
	if req.EncryptedUserSecretRecoveryB64 != "" {
		recovery, err = base64.StdEncoding.DecodeString(req.EncryptedUserSecretRecoveryB64)
		if err != nil {
			writeError(w, stdhttp.StatusBadRequest, "encrypted_user_secret_recovery must be base64")
			return
		}
	}

	u, err := h.Users.Create(r.Context(), user.CreateUserInput{
		ID:                          p.UserID,
		Handle:                      req.Handle,
		DisplayName:                 req.DisplayName,
		EncryptedUserSecret:         secret,
		EncryptedUserSecretRecovery: recovery,
	})
	switch {
	case errors.Is(err, user.ErrHandleInvalid):
		writeError(w, stdhttp.StatusBadRequest, "handle must be at least 3 characters")
		return
	case errors.Is(err, user.ErrHandleTaken):
		writeError(w, stdhttp.StatusConflict, "handle taken")
		return
	case errors.Is(err, user.ErrAlreadyExists):
		writeError(w, stdhttp.StatusConflict, "user already exists")
		return
	case err != nil:
		writeInternalError(w, err)
		return
	}
	writeJSON(w, stdhttp.StatusCreated, h.toResponse(u))
}

type patchMeRequest struct {
	Handle *string `json:"handle,omitempty"`
}

// patch updates mutable fields on the caller's user row. Currently the
// only one is `handle`; other writable fields will join this surface as
// they appear (display_name, avatar, is_discoverable). Omitting a field
// in the body leaves it untouched.
func (h *MeHandler) patch(w stdhttp.ResponseWriter, r *stdhttp.Request) {
	p := middleware.MustUser(r.Context())

	var req patchMeRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, stdhttp.StatusBadRequest, "invalid json")
		return
	}

	if req.Handle == nil {
		writeError(w, stdhttp.StatusBadRequest, "no fields to update")
		return
	}

	u, err := h.Users.UpdateHandle(r.Context(), p.UserID, *req.Handle)
	switch {
	case errors.Is(err, user.ErrHandleInvalid):
		writeError(w, stdhttp.StatusBadRequest, "handle must be at least 3 characters")
		return
	case errors.Is(err, user.ErrHandleTaken):
		writeError(w, stdhttp.StatusConflict, "handle taken")
		return
	case errors.Is(err, user.ErrNotFound):
		writeError(w, stdhttp.StatusNotFound, "user not found")
		return
	case err != nil:
		writeInternalError(w, err)
		return
	}
	writeJSON(w, stdhttp.StatusOK, h.toResponse(u))
}

// delete removes the caller's user row. Cascading FKs clean up dependents
// (user_server_links, handle_changes). Used by the client's "start fresh"
// recovery flow when the stored encrypted_user_secret cannot be decrypted —
// per the PRD there is no key recovery, so the user starts over.
func (h *MeHandler) delete(w stdhttp.ResponseWriter, r *stdhttp.Request) {
	p := middleware.MustUser(r.Context())
	if err := h.Users.Delete(r.Context(), p.UserID); err != nil {
		if errors.Is(err, user.ErrNotFound) {
			writeJSON(w, stdhttp.StatusNoContent, nil)
			return
		}
		writeInternalError(w, err)
		return
	}
	writeJSON(w, stdhttp.StatusNoContent, nil)
}

type updateSecretWrapsRequest struct {
	EncryptedUserSecretB64         string `json:"encrypted_user_secret,omitempty"`
	EncryptedUserSecretRecoveryB64 string `json:"encrypted_user_secret_recovery,omitempty"`
}

// updateSecretWraps replaces the password and/or recovery wrap of the caller's
// user_secret. Either field may be omitted (left untouched), serving both
// "enroll a recovery code later" (recovery only) and "re-wrap after a password
// reset" (password only). The plaintext user_secret never changes — only its
// server-stored ciphertext. At least one wrap must be present.
func (h *MeHandler) updateSecretWraps(w stdhttp.ResponseWriter, r *stdhttp.Request) {
	p := middleware.MustUser(r.Context())

	var req updateSecretWrapsRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, stdhttp.StatusBadRequest, "invalid json")
		return
	}

	var passwordWrap, recoveryWrap []byte
	if req.EncryptedUserSecretB64 != "" {
		b, err := base64.StdEncoding.DecodeString(req.EncryptedUserSecretB64)
		if err != nil {
			writeError(w, stdhttp.StatusBadRequest, "encrypted_user_secret must be base64")
			return
		}
		passwordWrap = b
	}
	if req.EncryptedUserSecretRecoveryB64 != "" {
		b, err := base64.StdEncoding.DecodeString(req.EncryptedUserSecretRecoveryB64)
		if err != nil {
			writeError(w, stdhttp.StatusBadRequest, "encrypted_user_secret_recovery must be base64")
			return
		}
		recoveryWrap = b
	}

	u, err := h.Users.UpdateUserSecretWraps(r.Context(), p.UserID, passwordWrap, recoveryWrap)
	switch {
	case errors.Is(err, user.ErrInvalidWrap):
		writeError(w, stdhttp.StatusBadRequest, "at least one wrap is required")
		return
	case errors.Is(err, user.ErrNotFound):
		writeError(w, stdhttp.StatusNotFound, "user not found")
		return
	case err != nil:
		writeInternalError(w, err)
		return
	}
	writeJSON(w, stdhttp.StatusOK, h.toResponse(u))
}

// uploadAvatar accepts the raw image bytes in the request body (Content-Type
// is the image type) and replaces the caller's profile image: validate +
// normalize + upload to R2, then point avatar_storage_key at the new object
// (deleting the previous one). Returns the refreshed user with avatar_url.
func (h *MeHandler) uploadAvatar(w stdhttp.ResponseWriter, r *stdhttp.Request) {
	p := middleware.MustUser(r.Context())
	if h.Avatar == nil || !h.Avatar.Configured() {
		writeError(w, stdhttp.StatusServiceUnavailable, "avatar uploads are not available")
		return
	}

	// Read one byte past the cap so we can distinguish "exactly at limit" from
	// "over limit" without trusting Content-Length.
	body, err := io.ReadAll(io.LimitReader(r.Body, avatar.MaxUploadBytes+1))
	if err != nil {
		writeError(w, stdhttp.StatusInternalServerError, "failed to read body")
		return
	}
	if len(body) > avatar.MaxUploadBytes {
		writeError(w, stdhttp.StatusRequestEntityTooLarge, "image too large")
		return
	}

	cur, err := h.Users.GetByID(r.Context(), p.UserID)
	if errors.Is(err, user.ErrNotFound) {
		writeError(w, stdhttp.StatusNotFound, "user not found")
		return
	}
	if err != nil {
		writeInternalError(w, err)
		return
	}
	prevKey := ""
	if cur.AvatarStorageKey != nil {
		prevKey = *cur.AvatarStorageKey
	}

	key, err := h.Avatar.Process(r.Context(), p.UserID, body, prevKey)
	switch {
	case errors.Is(err, avatar.ErrTooLarge):
		writeError(w, stdhttp.StatusRequestEntityTooLarge, "image too large")
		return
	case errors.Is(err, avatar.ErrUnsupportedImage):
		writeError(w, stdhttp.StatusBadRequest, "unsupported or invalid image")
		return
	case errors.Is(err, avatar.ErrNotConfigured):
		writeError(w, stdhttp.StatusServiceUnavailable, "avatar uploads are not available")
		return
	case err != nil:
		writeInternalError(w, err)
		return
	}

	updated, err := h.Users.SetAvatarKey(r.Context(), p.UserID, &key)
	if err != nil {
		writeInternalError(w, err)
		return
	}
	writeJSON(w, stdhttp.StatusOK, h.toResponse(updated))
}

// deleteAvatar clears the caller's profile image (best-effort R2 delete).
func (h *MeHandler) deleteAvatar(w stdhttp.ResponseWriter, r *stdhttp.Request) {
	p := middleware.MustUser(r.Context())
	cur, err := h.Users.GetByID(r.Context(), p.UserID)
	if errors.Is(err, user.ErrNotFound) {
		writeError(w, stdhttp.StatusNotFound, "user not found")
		return
	}
	if err != nil {
		writeInternalError(w, err)
		return
	}
	if cur.AvatarStorageKey != nil && h.Avatar != nil {
		_ = h.Avatar.Remove(r.Context(), *cur.AvatarStorageKey)
	}
	updated, err := h.Users.SetAvatarKey(r.Context(), p.UserID, nil)
	if err != nil {
		writeInternalError(w, err)
		return
	}
	writeJSON(w, stdhttp.StatusOK, h.toResponse(updated))
}
