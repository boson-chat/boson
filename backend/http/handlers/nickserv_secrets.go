package handlers

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	stdhttp "net/http"
	"strings"

	"github.com/boson-chat/boson/backend/http/middleware"
	"github.com/boson-chat/boson/backend/internal/services/nickservsecret"
)

// NickServSecretsHandler exposes per-user, end-to-end-encrypted NickServ
// passwords. The renderer encrypts {nickservPassword, accountName} under a key
// derived from its user_secret and syncs the opaque ciphertext here so it
// follows the user across devices. The server stores blobs it cannot decrypt.
type NickServSecretsHandler struct {
	Secrets nickservsecret.ServiceImpl
}

func NewNickServSecretsHandler(s nickservsecret.ServiceImpl) *NickServSecretsHandler {
	return &NickServSecretsHandler{Secrets: s}
}

func (h *NickServSecretsHandler) Register(mux *stdhttp.ServeMux) {
	mux.HandleFunc("GET /me/nickserv-secrets", h.list)
	mux.HandleFunc("PUT /me/nickserv-secrets/{serverId}", h.put)
	mux.HandleFunc("DELETE /me/nickserv-secrets/{serverId}", h.delete)
}

type nickservSecretDTO struct {
	ServerID   string `json:"server_id"`
	Ciphertext string `json:"ciphertext"` // base64
	UpdatedAt  string `json:"updated_at"`
}

func (h *NickServSecretsHandler) list(w stdhttp.ResponseWriter, r *stdhttp.Request) {
	p := middleware.MustUser(r.Context())
	rows, err := h.Secrets.List(r.Context(), p.UserID)
	if err != nil {
		writeInternalError(w, err)
		return
	}
	out := make([]nickservSecretDTO, 0, len(rows))
	for _, s := range rows {
		out = append(out, nickservSecretDTO{
			ServerID:   s.ServerID,
			Ciphertext: base64.StdEncoding.EncodeToString(s.Ciphertext),
			UpdatedAt:  s.UpdatedAt.UTC().Format("2006-01-02T15:04:05.999999Z07:00"),
		})
	}
	writeJSON(w, stdhttp.StatusOK, map[string]any{"secrets": out})
}

type putNickservSecretRequest struct {
	Ciphertext string `json:"ciphertext"` // base64
}

func (h *NickServSecretsHandler) put(w stdhttp.ResponseWriter, r *stdhttp.Request) {
	p := middleware.MustUser(r.Context())
	serverID := strings.TrimSpace(r.PathValue("serverId"))
	if serverID == "" {
		writeError(w, stdhttp.StatusBadRequest, "serverId is required")
		return
	}

	var req putNickservSecretRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, stdhttp.StatusBadRequest, "invalid json")
		return
	}
	ciphertext, err := base64.StdEncoding.DecodeString(req.Ciphertext)
	if err != nil {
		writeError(w, stdhttp.StatusBadRequest, "ciphertext must be base64")
		return
	}

	s, err := h.Secrets.Put(r.Context(), p.UserID, serverID, ciphertext)
	switch {
	case errors.Is(err, nickservsecret.ErrEmptyCiphertext):
		writeError(w, stdhttp.StatusBadRequest, "ciphertext is required")
		return
	case errors.Is(err, nickservsecret.ErrInvalidServerID):
		writeError(w, stdhttp.StatusBadRequest, "server_id is required")
		return
	case err != nil:
		writeInternalError(w, err)
		return
	}
	writeJSON(w, stdhttp.StatusOK, nickservSecretDTO{
		ServerID:   s.ServerID,
		Ciphertext: base64.StdEncoding.EncodeToString(s.Ciphertext),
		UpdatedAt:  s.UpdatedAt.UTC().Format("2006-01-02T15:04:05.999999Z07:00"),
	})
}

func (h *NickServSecretsHandler) delete(w stdhttp.ResponseWriter, r *stdhttp.Request) {
	p := middleware.MustUser(r.Context())
	serverID := strings.TrimSpace(r.PathValue("serverId"))
	if serverID == "" {
		writeError(w, stdhttp.StatusBadRequest, "serverId is required")
		return
	}
	err := h.Secrets.Delete(r.Context(), p.UserID, serverID)
	if err != nil && !errors.Is(err, nickservsecret.ErrNotFound) {
		writeInternalError(w, err)
		return
	}
	// Idempotent delete — 204 whether or not a row existed.
	writeJSON(w, stdhttp.StatusNoContent, nil)
}
