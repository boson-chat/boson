package handlers

import (
	"encoding/json"
	"errors"
	stdhttp "net/http"
	"strconv"
	"time"

	"github.com/boson-chat/boson/backend/http/middleware"
	"github.com/boson-chat/boson/backend/internal/services/server"
	"github.com/boson-chat/boson/backend/internal/services/server/dns"

	"github.com/google/uuid"
)

// verifyRateLimitWindow caps how often the same authenticated principal
// can fire POST /servers/{id}/verify against the same server. 30s is
// long enough that DNS propagation has a chance to settle between
// retries; short enough that an honest operator never notices.
const verifyRateLimitWindow = 30 * time.Second

type ServerHandler struct {
	Servers server.ServerServiceImpl
}

func NewServerHandler(servers server.ServerServiceImpl) *ServerHandler {
	return &ServerHandler{Servers: servers}
}

// RegisterPublic mounts the read-only directory routes that don't require auth.
// Anyone — including guest users with no Supabase session — can browse the
// server directory; auth is only needed to add a new server.
func (h *ServerHandler) RegisterPublic(mux *stdhttp.ServeMux) {
	mux.HandleFunc("GET /servers", h.list)
	mux.HandleFunc("GET /servers/{id}", h.get)
}

// RegisterProtected mounts the directory routes that require an authenticated
// principal. Server creation records the registering user via
// middleware.MustUser; the verify / regenerate routes additionally enforce
// that the caller is the row's `registered_by`. `/servers/{id}/verify` is
// rate-limited per (principal, server-id) at 1 request per 30s — DNS
// propagation is slow and rapid retries don't help, so we cap them.
func (h *ServerHandler) RegisterProtected(mux *stdhttp.ServeMux) {
	mux.HandleFunc("POST /servers", h.create)
	mux.HandleFunc("GET /servers/me", h.listMine)
	verifyLimit := middleware.RateLimit(verifyRateLimitWindow, middleware.PrincipalAndPath("id"))
	mux.Handle("POST /servers/{id}/verify", verifyLimit(stdhttp.HandlerFunc(h.verify)))
	mux.HandleFunc("POST /servers/{id}/regenerate-token", h.regenerateToken)
	mux.HandleFunc("PATCH /servers/{id}", h.updateProfile)
}

// Register mounts every directory route on a single mux. Retained so unit
// tests that drive the handler directly (no real auth middleware) can wire
// public + protected routes in one call.
func (h *ServerHandler) Register(mux *stdhttp.ServeMux) {
	h.RegisterPublic(mux)
	h.RegisterProtected(mux)
}

func (h *ServerHandler) list(w stdhttp.ResponseWriter, r *stdhttp.Request) {
	q := r.URL.Query()
	limit, _ := strconv.Atoi(q.Get("limit"))
	offset, _ := strconv.Atoi(q.Get("offset"))

	// Public list deliberately filters to verified rows only. Pending /
	// lapsed listings are visible to their owner via GET /servers/me and
	// to admins via direct DB queries; we don't expose them in the
	// directory until they've cleared verification.
	results, err := h.Servers.List(r.Context(), server.ListFilter{
		Query:       q.Get("q"),
		Language:    q.Get("lang"),
		IncludeNSFW: q.Get("nsfw") == "true",
		Sort:        q.Get("sort"),
		Limit:       limit,
		Offset:      offset,
		Status:      "verified",
	})
	if err != nil {
		writeError(w, stdhttp.StatusInternalServerError, err.Error())
		return
	}

	writeJSON(w, stdhttp.StatusOK, map[string]any{
		"servers": results,
		"count":   len(results),
	})
}

type createServerRequest struct {
	Hostname    string   `json:"hostname"`
	Port        int      `json:"port"`
	TLS         *bool    `json:"tls,omitempty"`
	Name        string   `json:"name"`
	Description *string  `json:"description,omitempty"`
	Tags        []string `json:"tags,omitempty"`
	Languages   []string `json:"languages,omitempty"`
	IsNSFW      bool     `json:"is_nsfw,omitempty"`
}

func (h *ServerHandler) create(w stdhttp.ResponseWriter, r *stdhttp.Request) {
	p := middleware.MustUser(r.Context())

	var req createServerRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, stdhttp.StatusBadRequest, "invalid json")
		return
	}

	tls := true
	if req.TLS != nil {
		tls = *req.TLS
	}

	srv, err := h.Servers.Create(r.Context(), p.UserID, server.CreateInput{
		Hostname:    req.Hostname,
		Port:        req.Port,
		TLS:         tls,
		Name:        req.Name,
		Description: req.Description,
		Tags:        req.Tags,
		Languages:   req.Languages,
		IsNSFW:      req.IsNSFW,
	})
	if errors.Is(err, server.ErrInvalidInput) {
		writeError(w, stdhttp.StatusBadRequest, "hostname, name, and 1<=port<=65535 are required")
		return
	}
	if err != nil {
		writeError(w, stdhttp.StatusInternalServerError, err.Error())
		return
	}
	// 201 response carries the freshly-minted verification_token so the
	// client can show it to the operator exactly once. Subsequent reads
	// via GET /servers/me hide it after the row reaches verified status.
	writeJSON(w, stdhttp.StatusCreated, srv.ToOwnerView())
}

func (h *ServerHandler) listMine(w stdhttp.ResponseWriter, r *stdhttp.Request) {
	p := middleware.MustUser(r.Context())
	results, err := h.Servers.ListByOwner(r.Context(), p.UserID)
	if err != nil {
		writeError(w, stdhttp.StatusInternalServerError, err.Error())
		return
	}
	// Marshal each row through ToOwnerView so the verification_token
	// surfaces only for rows still in pending status (where the operator
	// genuinely needs to copy it again).
	views := make([]any, len(results))
	for i, s := range results {
		views[i] = s.ToOwnerView()
	}
	writeJSON(w, stdhttp.StatusOK, map[string]any{
		"servers": views,
		"count":   len(views),
	})
}

func (h *ServerHandler) verify(w stdhttp.ResponseWriter, r *stdhttp.Request) {
	p := middleware.MustUser(r.Context())
	id, err := uuid.Parse(r.PathValue("id"))
	if err != nil {
		writeError(w, stdhttp.StatusBadRequest, "invalid id")
		return
	}
	srv, report, err := h.Servers.Verify(r.Context(), id, p.UserID, dns.ModeStrict)
	switch {
	case errors.Is(err, server.ErrNotFound):
		writeError(w, stdhttp.StatusNotFound, "not found")
		return
	case errors.Is(err, server.ErrNotOwner):
		writeError(w, stdhttp.StatusForbidden, "not the owner")
		return
	case errors.Is(err, server.ErrTokenExpired):
		// 410 Gone is the closest fit — the token resource itself no
		// longer exists from the verifier's point of view. The client
		// renders "expired" and offers the regenerate path.
		writeError(w, stdhttp.StatusGone, "verification token expired; regenerate to try again")
		return
	case errors.Is(err, server.ErrMissingToken):
		writeError(w, stdhttp.StatusConflict, "no verification token to check; regenerate first")
		return
	case err != nil:
		writeError(w, stdhttp.StatusInternalServerError, err.Error())
		return
	}

	// Successful match → 200. Partial / missing → 409 with the
	// per-resolver matrix so the client UI can show "Cloudflare ✓ /
	// Google ✗ / Quad9 ✓ — TXT may still be propagating."
	status := stdhttp.StatusOK
	if !report.Success {
		status = stdhttp.StatusConflict
	}
	writeJSON(w, status, map[string]any{
		"server":  srv.ToOwnerView(),
		"report":  report,
		"success": report.Success,
	})
}

// updateProfile lets the row's owner mutate the human-facing fields —
// display name, description, tags, languages, NSFW flag — without
// touching identity (hostname/port/TLS) or verification status.
// Identity changes would invalidate the existing TXT record so we
// don't allow them through this path; the operator has to register
// a new row + delete the old one if they really need to move ports.
type updateProfileRequest struct {
	Name        *string   `json:"name,omitempty"`
	Description *string   `json:"description,omitempty"`
	Tags        *[]string `json:"tags,omitempty"`
	Languages   *[]string `json:"languages,omitempty"`
	IsNSFW      *bool     `json:"is_nsfw,omitempty"`
}

func (h *ServerHandler) updateProfile(w stdhttp.ResponseWriter, r *stdhttp.Request) {
	p := middleware.MustUser(r.Context())
	id, err := uuid.Parse(r.PathValue("id"))
	if err != nil {
		writeError(w, stdhttp.StatusBadRequest, "invalid id")
		return
	}
	var req updateProfileRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, stdhttp.StatusBadRequest, "invalid json")
		return
	}
	srv, err := h.Servers.UpdateProfile(r.Context(), id, p.UserID, server.UpdateProfileInput{
		Name:        req.Name,
		Description: req.Description,
		Tags:        req.Tags,
		Languages:   req.Languages,
		IsNSFW:      req.IsNSFW,
	})
	switch {
	case errors.Is(err, server.ErrNotFound):
		writeError(w, stdhttp.StatusNotFound, "not found")
		return
	case errors.Is(err, server.ErrNotOwner):
		writeError(w, stdhttp.StatusForbidden, "not the owner")
		return
	case errors.Is(err, server.ErrInvalidInput):
		writeError(w, stdhttp.StatusBadRequest, "name must be non-empty")
		return
	case err != nil:
		writeError(w, stdhttp.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, stdhttp.StatusOK, srv.ToOwnerView())
}

func (h *ServerHandler) regenerateToken(w stdhttp.ResponseWriter, r *stdhttp.Request) {
	p := middleware.MustUser(r.Context())
	id, err := uuid.Parse(r.PathValue("id"))
	if err != nil {
		writeError(w, stdhttp.StatusBadRequest, "invalid id")
		return
	}
	srv, err := h.Servers.RegenerateToken(r.Context(), id, p.UserID)
	switch {
	case errors.Is(err, server.ErrNotFound):
		writeError(w, stdhttp.StatusNotFound, "not found")
		return
	case errors.Is(err, server.ErrNotOwner):
		writeError(w, stdhttp.StatusForbidden, "not the owner")
		return
	case err != nil:
		writeError(w, stdhttp.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, stdhttp.StatusOK, srv.ToOwnerView())
}

func (h *ServerHandler) get(w stdhttp.ResponseWriter, r *stdhttp.Request) {
	id, err := uuid.Parse(r.PathValue("id"))
	if err != nil {
		writeError(w, stdhttp.StatusBadRequest, "invalid id")
		return
	}
	s, err := h.Servers.GetByID(r.Context(), id)
	if errors.Is(err, server.ErrNotFound) {
		writeError(w, stdhttp.StatusNotFound, "not found")
		return
	}
	if err != nil {
		writeError(w, stdhttp.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, stdhttp.StatusOK, s)
}
