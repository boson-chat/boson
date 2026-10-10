package handlers

import (
	"encoding/json"
	"errors"
	"fmt"
	stdhttp "net/http"

	"github.com/boson-chat/boson/backend/http/middleware"
	"github.com/boson-chat/boson/backend/internal/services/avatar"
	"github.com/boson-chat/boson/backend/internal/services/presence"
)

const (
	// maxPresencePublishBody bounds PUT /me/presence: one nick + host +
	// account is a few hundred bytes at most.
	maxPresencePublishBody = 4 << 10
	// maxLookupMembers caps how many observed users one lookup may ask
	// about — comfortably above a busy channel's visible member list,
	// small enough that one request can't make the server match a huge
	// set. Larger requests are rejected (400) rather than truncated so
	// the client notices and batches.
	maxLookupMembers = 500
	// maxPresenceLookupBody bounds POST /presence/lookup so the decoder
	// never buffers more than maxLookupMembers' worth of JSON (plus
	// slack) before the count check can run.
	maxPresenceLookupBody = 256 << 10
)

// decodePresenceBody decodes a size-capped JSON body. On failure it has
// already written the response (413 for oversize, 400 otherwise).
func decodePresenceBody(w stdhttp.ResponseWriter, r *stdhttp.Request, limit int64, dst any) bool {
	r.Body = stdhttp.MaxBytesReader(w, r.Body, limit)
	if err := json.NewDecoder(r.Body).Decode(dst); err != nil {
		var tooBig *stdhttp.MaxBytesError
		if errors.As(err, &tooBig) {
			writeError(w, stdhttp.StatusRequestEntityTooLarge, "request body too large")
			return false
		}
		writeError(w, stdhttp.StatusBadRequest, "invalid json")
		return false
	}
	return true
}

type PresenceHandler struct {
	Presence presence.ServiceImpl
	// Avatar may be nil (R2 not configured) — matches still return, just
	// without an avatar_url.
	Avatar avatar.ServiceImpl
}

func NewPresenceHandler(p presence.ServiceImpl, a avatar.ServiceImpl) *PresenceHandler {
	return &PresenceHandler{Presence: p, Avatar: a}
}

func (h *PresenceHandler) Register(mux *stdhttp.ServeMux) {
	mux.HandleFunc("PUT /me/presence", h.publish)
	mux.HandleFunc("POST /presence/lookup", h.lookup)
}

type publishPresenceRequest struct {
	Network string `json:"network"`
	Nick    string `json:"nick"`
	Host    string `json:"host,omitempty"`
	Account string `json:"account,omitempty"`
}

// publish stores the caller's current IRC identity on a network so other
// Boson clients can match them.
func (h *PresenceHandler) publish(w stdhttp.ResponseWriter, r *stdhttp.Request) {
	p := middleware.MustUser(r.Context())
	var req publishPresenceRequest
	if !decodePresenceBody(w, r, maxPresencePublishBody, &req) {
		return
	}
	_, err := h.Presence.Publish(r.Context(), p.UserID, req.Network, req.Nick, req.Host, req.Account)
	switch {
	case errors.Is(err, presence.ErrInvalidNetwork):
		writeError(w, stdhttp.StatusBadRequest, "network is required")
		return
	case errors.Is(err, presence.ErrInvalidNick):
		writeError(w, stdhttp.StatusBadRequest, "nick is required")
		return
	case err != nil:
		writeInternalError(w, err)
		return
	}
	writeJSON(w, stdhttp.StatusNoContent, nil)
}

type lookupMemberInput struct {
	Nick    string `json:"nick"`
	Host    string `json:"host,omitempty"`
	Account string `json:"account,omitempty"`
}

type lookupRequest struct {
	Network string              `json:"network"`
	Members []lookupMemberInput `json:"members"`
}

type lookupMatchOut struct {
	Nick        string  `json:"nick"`
	Handle      string  `json:"handle"`
	DisplayName *string `json:"display_name,omitempty"`
	AvatarURL   string  `json:"avatar_url,omitempty"`
}

type lookupResponse struct {
	Matches []lookupMatchOut `json:"matches"`
}

// lookup resolves which of the observed users are Boson members, returning
// their handle + avatar URL (never their host).
func (h *PresenceHandler) lookup(w stdhttp.ResponseWriter, r *stdhttp.Request) {
	_ = middleware.MustUser(r.Context()) // auth-gated; identity not otherwise used
	var req lookupRequest
	if !decodePresenceBody(w, r, maxPresenceLookupBody, &req) {
		return
	}
	if len(req.Members) > maxLookupMembers {
		writeError(w, stdhttp.StatusBadRequest, fmt.Sprintf("too many members (max %d)", maxLookupMembers))
		return
	}
	items := make([]presence.LookupItem, 0, len(req.Members))
	for _, m := range req.Members {
		if m.Nick == "" {
			continue
		}
		items = append(items, presence.LookupItem{Nick: m.Nick, Host: m.Host, Account: m.Account})
	}
	matches, err := h.Presence.Lookup(r.Context(), req.Network, items)
	switch {
	case errors.Is(err, presence.ErrInvalidNetwork):
		writeError(w, stdhttp.StatusBadRequest, "network is required")
		return
	case err != nil:
		writeInternalError(w, err)
		return
	}
	out := lookupResponse{Matches: make([]lookupMatchOut, 0, len(matches))}
	for _, m := range matches {
		url := ""
		if m.AvatarKey != nil && h.Avatar != nil {
			url = h.Avatar.URLFor(*m.AvatarKey)
		}
		out.Matches = append(out.Matches, lookupMatchOut{
			Nick:        m.Nick,
			Handle:      m.Handle,
			DisplayName: m.DisplayName,
			AvatarURL:   url,
		})
	}
	writeJSON(w, stdhttp.StatusOK, out)
}
