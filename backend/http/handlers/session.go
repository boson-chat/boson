package handlers

import (
	"encoding/json"
	"errors"
	stdhttp "net/http"

	"github.com/boson-chat/boson/backend/http/middleware"
	"github.com/boson-chat/boson/backend/internal/services/session"
)

// SessionHandler exposes per-user saved-session storage. The renderer mirrors
// its local SessionStore (servers + joined channels + active cursor) into
// this endpoint so a fresh device install lands on the same state.
type SessionHandler struct {
	Sessions session.ServiceImpl
}

func NewSessionHandler(s session.ServiceImpl) *SessionHandler {
	return &SessionHandler{Sessions: s}
}

func (h *SessionHandler) Register(mux *stdhttp.ServeMux) {
	mux.HandleFunc("GET /me/session", h.get)
	mux.HandleFunc("PUT /me/session", h.put)
}

// get returns the caller's saved session payload. 200 with an empty
// `{ "payload": null }` shape when nothing is stored yet, so the client
// doesn't have to special-case 404 on first sign-in.
func (h *SessionHandler) get(w stdhttp.ResponseWriter, r *stdhttp.Request) {
	p := middleware.MustUser(r.Context())
	s, err := h.Sessions.Get(r.Context(), p.UserID)
	if errors.Is(err, session.ErrNotFound) {
		writeJSON(w, stdhttp.StatusOK, map[string]any{"payload": nil})
		return
	}
	if err != nil {
		writeError(w, stdhttp.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, stdhttp.StatusOK, map[string]any{
		"payload":    json.RawMessage(s.Payload),
		"updated_at": s.UpdatedAt,
	})
}

type putSessionRequest struct {
	Payload json.RawMessage `json:"payload"`
}

func (h *SessionHandler) put(w stdhttp.ResponseWriter, r *stdhttp.Request) {
	p := middleware.MustUser(r.Context())

	var req putSessionRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, stdhttp.StatusBadRequest, "invalid json")
		return
	}
	if len(req.Payload) == 0 {
		writeError(w, stdhttp.StatusBadRequest, "payload is required")
		return
	}
	// Require the payload to parse as a JSON object — guards against
	// callers sending naked numbers / arrays that would then surprise
	// the renderer on read.
	var obj map[string]any
	if err := json.Unmarshal(req.Payload, &obj); err != nil {
		writeError(w, stdhttp.StatusBadRequest, "payload must be a JSON object")
		return
	}

	s, err := h.Sessions.Put(r.Context(), p.UserID, req.Payload)
	if err != nil {
		writeError(w, stdhttp.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, stdhttp.StatusOK, map[string]any{
		"payload":    json.RawMessage(s.Payload),
		"updated_at": s.UpdatedAt,
	})
}
