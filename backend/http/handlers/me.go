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
	mux.HandleFunc("DELETE /me", h.delete)
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
	Handle                 string  `json:"handle"`
	DisplayName            *string `json:"display_name,omitempty"`
	EncryptedUserSecretB64 string  `json:"encrypted_user_secret"`
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

	u, err := h.Users.Create(r.Context(), user.CreateUserInput{
		ID:                  p.UserID,
		Handle:              req.Handle,
		DisplayName:         req.DisplayName,
		EncryptedUserSecret: secret,
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
