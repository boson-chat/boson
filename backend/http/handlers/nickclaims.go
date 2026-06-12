package handlers

import (
	"encoding/json"
	"errors"
	stdhttp "net/http"
	"strings"

	"github.com/boson-chat/boson/backend/http/middleware"
	"github.com/boson-chat/boson/backend/internal/services/nickclaim"

	"github.com/google/uuid"
)

// NickClaimsHandler exposes the two authenticated endpoints that let
// a signed-in client mint a "claim this nick" record and poll for
// the confirmation code captured from email.
//
// The handler itself is thin — orchestration lives in the
// nickclaim.Service. Most of the surface area is request shaping,
// status mapping, and the per-user rate-limit + RLS guards.
type NickClaimsHandler struct {
	Claims nickclaim.ServiceImpl
}

func NewNickClaimsHandler(claims nickclaim.ServiceImpl) *NickClaimsHandler {
	return &NickClaimsHandler{Claims: claims}
}

func (h *NickClaimsHandler) Register(mux *stdhttp.ServeMux) {
	mux.HandleFunc("POST /me/nick-claims", h.create)
	mux.HandleFunc("GET /me/nick-claims/{id}", h.get)
}

type createNickClaimRequest struct {
	ServerID    string `json:"server_id"`
	AccountNick string `json:"account_nick"`
}

type createNickClaimResponse struct {
	ID    string `json:"id"`
	Email string `json:"email"`
}

func (h *NickClaimsHandler) create(w stdhttp.ResponseWriter, r *stdhttp.Request) {
	p := middleware.MustUser(r.Context())

	var req createNickClaimRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, stdhttp.StatusBadRequest, "invalid json")
		return
	}
	req.ServerID = strings.TrimSpace(req.ServerID)
	req.AccountNick = strings.TrimSpace(req.AccountNick)
	if req.ServerID == "" || req.AccountNick == "" {
		writeError(w, stdhttp.StatusBadRequest, "server_id and account_nick are required")
		return
	}

	claim, err := h.Claims.CreateClaim(r.Context(), p.UserID, req.ServerID, req.AccountNick)
	switch {
	case errors.Is(err, nickclaim.ErrRateLimited):
		// 429 — caller has minted too many claims in the last hour.
		// Response includes the standard `error` key plus a
		// machine-readable kind so the client can render a
		// specific message ("you've started too many; wait").
		writeJSON(w, stdhttp.StatusTooManyRequests, map[string]string{
			"error": "too many claims in the last hour",
			"kind":  "rate_limited",
		})
		return
	case err != nil:
		writeError(w, stdhttp.StatusInternalServerError, err.Error())
		return
	}

	writeJSON(w, stdhttp.StatusCreated, createNickClaimResponse{
		ID:    claim.ID.String(),
		Email: h.Claims.EmailFor(claim),
	})
}

type getNickClaimResponse struct {
	Status string  `json:"status"`
	Code   *string `json:"code,omitempty"`
}

func (h *NickClaimsHandler) get(w stdhttp.ResponseWriter, r *stdhttp.Request) {
	p := middleware.MustUser(r.Context())

	idStr := r.PathValue("id")
	id, err := uuid.Parse(idStr)
	if err != nil {
		writeError(w, stdhttp.StatusBadRequest, "invalid id")
		return
	}

	// ConsumeIfCaptured side-effects the captured → consumed
	// transition. Idempotent: repeated polls after a code is
	// returned see the row with status = consumed + the same code,
	// so the client can safely retry the poll if its first response
	// got lost in transit.
	claim, err := h.Claims.ConsumeIfCaptured(r.Context(), id, p.UserID)
	switch {
	case errors.Is(err, nickclaim.ErrNotFound):
		writeError(w, stdhttp.StatusNotFound, "not found")
		return
	case err != nil:
		writeError(w, stdhttp.StatusInternalServerError, err.Error())
		return
	}

	resp := getNickClaimResponse{Status: claim.Status}
	// Only surface the code once the row has transitioned out of
	// pending. The `code` field on the DB row is technically set
	// on capture, but exposing it via the captured-but-not-consumed
	// status would leak the code if the polling client is somehow
	// not the owner (shouldn't happen — RLS already guards — but
	// belt-and-braces).
	if claim.Status == nickclaim.StatusCaptured || claim.Status == nickclaim.StatusConsumed {
		resp.Code = claim.Code
	}
	writeJSON(w, stdhttp.StatusOK, resp)
}
