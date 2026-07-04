package handlers

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	stdhttp "net/http"

	"github.com/boson-chat/boson/backend/http/middleware"
	"github.com/boson-chat/boson/backend/internal/services/bouncersecret"
)

// BouncerSecretHandler exposes the per-user, end-to-end-encrypted bouncer
// (ZNC/BNC) profile. The renderer encrypts {enabled, host, port, tls,
// tlsInsecure, username, password} under a key derived from its user_secret
// and syncs the opaque ciphertext here so the profile follows the user across
// devices. The server stores a blob it cannot decrypt.
type BouncerSecretHandler struct {
	Secrets bouncersecret.ServiceImpl
}

func NewBouncerSecretHandler(s bouncersecret.ServiceImpl) *BouncerSecretHandler {
	return &BouncerSecretHandler{Secrets: s}
}

func (h *BouncerSecretHandler) Register(mux *stdhttp.ServeMux) {
	mux.HandleFunc("GET /me/bouncer", h.get)
	mux.HandleFunc("PUT /me/bouncer", h.put)
	mux.HandleFunc("DELETE /me/bouncer", h.delete)
}

type bouncerSecretDTO struct {
	Ciphertext string `json:"ciphertext"` // base64
	UpdatedAt  string `json:"updated_at"`
}

func toBouncerDTO(s *bouncersecret.BouncerSecret) bouncerSecretDTO {
	return bouncerSecretDTO{
		Ciphertext: base64.StdEncoding.EncodeToString(s.Ciphertext),
		UpdatedAt:  s.UpdatedAt.UTC().Format("2006-01-02T15:04:05.999999Z07:00"),
	}
}

func (h *BouncerSecretHandler) get(w stdhttp.ResponseWriter, r *stdhttp.Request) {
	p := middleware.MustUser(r.Context())
	s, err := h.Secrets.Get(r.Context(), p.UserID)
	if errors.Is(err, bouncersecret.ErrNotFound) {
		// Explicit null so the client distinguishes "no profile yet" from a
		// transport error (and won't clobber a locally-configured profile).
		writeJSON(w, stdhttp.StatusOK, map[string]any{"bouncer": nil})
		return
	}
	if err != nil {
		writeInternalError(w, err)
		return
	}
	writeJSON(w, stdhttp.StatusOK, map[string]any{"bouncer": toBouncerDTO(s)})
}

type putBouncerSecretRequest struct {
	Ciphertext string `json:"ciphertext"` // base64
}

func (h *BouncerSecretHandler) put(w stdhttp.ResponseWriter, r *stdhttp.Request) {
	p := middleware.MustUser(r.Context())

	var req putBouncerSecretRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, stdhttp.StatusBadRequest, "invalid json")
		return
	}
	ciphertext, err := base64.StdEncoding.DecodeString(req.Ciphertext)
	if err != nil {
		writeError(w, stdhttp.StatusBadRequest, "ciphertext must be base64")
		return
	}

	s, err := h.Secrets.Put(r.Context(), p.UserID, ciphertext)
	switch {
	case errors.Is(err, bouncersecret.ErrEmptyCiphertext):
		writeError(w, stdhttp.StatusBadRequest, "ciphertext is required")
		return
	case err != nil:
		writeInternalError(w, err)
		return
	}
	writeJSON(w, stdhttp.StatusOK, toBouncerDTO(s))
}

func (h *BouncerSecretHandler) delete(w stdhttp.ResponseWriter, r *stdhttp.Request) {
	p := middleware.MustUser(r.Context())
	if err := h.Secrets.Delete(r.Context(), p.UserID); err != nil {
		writeInternalError(w, err)
		return
	}
	// Idempotent delete — 204 whether or not a row existed.
	writeJSON(w, stdhttp.StatusNoContent, nil)
}
