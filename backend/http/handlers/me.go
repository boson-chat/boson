package handlers

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	stdhttp "net/http"

	"github.com/boson-chat/boson/backend/http/middleware"
	"github.com/boson-chat/boson/backend/internal/services/user"
)

type MeHandler struct {
	Users user.UserServiceImpl
}

func NewMeHandler(users user.UserServiceImpl) *MeHandler {
	return &MeHandler{Users: users}
}

func (h *MeHandler) Register(mux *stdhttp.ServeMux) {
	mux.HandleFunc("GET /me", h.get)
	mux.HandleFunc("POST /me", h.create)
	mux.HandleFunc("PATCH /me", h.patch)
	mux.HandleFunc("DELETE /me", h.delete)
	mux.HandleFunc("PUT /me/secret-wraps", h.updateSecretWraps)
}

func (h *MeHandler) get(w stdhttp.ResponseWriter, r *stdhttp.Request) {
	p := middleware.MustUser(r.Context())
	u, err := h.Users.GetByID(r.Context(), p.UserID)
	if errors.Is(err, user.ErrNotFound) {
		writeJSON(w, stdhttp.StatusNotFound, map[string]string{"status": "needs_setup"})
		return
	}
	if err != nil {
		writeError(w, stdhttp.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, stdhttp.StatusOK, u)
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
		writeError(w, stdhttp.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, stdhttp.StatusCreated, u)
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
		writeError(w, stdhttp.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, stdhttp.StatusOK, u)
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
		writeError(w, stdhttp.StatusInternalServerError, err.Error())
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
		writeError(w, stdhttp.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, stdhttp.StatusOK, u)
}
