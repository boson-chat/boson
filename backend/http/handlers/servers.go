package handlers

import (
	"encoding/json"
	"errors"
	"io"
	stdhttp "net/http"
	"strconv"
	"time"

	"github.com/boson-chat/boson/backend/http/middleware"
	"github.com/boson-chat/boson/backend/internal/services/avatar"
	"github.com/boson-chat/boson/backend/internal/services/server"
	"github.com/boson-chat/boson/backend/internal/services/server/dns"

	"github.com/google/uuid"
)

// verifyRateLimitWindow caps how often the same authenticated principal
// can fire POST /servers/{id}/verify against the same server. 30s is
// long enough that DNS propagation has a chance to settle between
// retries; short enough that an honest operator never notices.
const verifyRateLimitWindow = 30 * time.Second

// Listing image dimensions: a square icon + a wide banner (3:1).
const (
	serverIconSize = 256
	serverBannerW  = 1200
	serverBannerH  = 400
)

type ServerHandler struct {
	Servers server.ServerServiceImpl
	// Avatar may be nil (R2 not configured) — the icon/banner routes 503 and
	// icon_url/banner_url are omitted.
	Avatar avatar.ServiceImpl
}

func NewServerHandler(servers server.ServerServiceImpl, avatars avatar.ServiceImpl) *ServerHandler {
	return &ServerHandler{Servers: servers, Avatar: avatars}
}

// enrich fills a server's computed CDN image URLs from its storage keys.
func (h *ServerHandler) enrich(s *server.Server) *server.Server {
	if s == nil || h.Avatar == nil {
		return s
	}
	if s.IconStorageKey != nil {
		s.IconURL = h.Avatar.URLFor(*s.IconStorageKey)
	}
	if s.BannerStorageKey != nil {
		s.BannerURL = h.Avatar.URLFor(*s.BannerStorageKey)
	}
	return s
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
	mux.HandleFunc("POST /servers/{id}/icon", h.uploadIcon)
	mux.HandleFunc("DELETE /servers/{id}/icon", h.deleteIcon)
	mux.HandleFunc("POST /servers/{id}/banner", h.uploadBanner)
	mux.HandleFunc("DELETE /servers/{id}/banner", h.deleteBanner)
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
		writeInternalError(w, err)
		return
	}
	for _, s := range results {
		h.enrich(s)
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
		writeInternalError(w, err)
		return
	}
	// 201 response carries the freshly-minted verification_token so the
	// client can show it to the operator exactly once. Subsequent reads
	// via GET /servers/me hide it after the row reaches verified status.
	writeJSON(w, stdhttp.StatusCreated, h.enrich(srv).ToOwnerView())
}

func (h *ServerHandler) listMine(w stdhttp.ResponseWriter, r *stdhttp.Request) {
	p := middleware.MustUser(r.Context())
	results, err := h.Servers.ListByOwner(r.Context(), p.UserID)
	if err != nil {
		writeInternalError(w, err)
		return
	}
	// Marshal each row through ToOwnerView so the verification_token
	// surfaces only for rows still in pending status (where the operator
	// genuinely needs to copy it again).
	views := make([]any, len(results))
	for i, s := range results {
		views[i] = h.enrich(s).ToOwnerView()
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
		writeInternalError(w, err)
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
		"server":  h.enrich(srv).ToOwnerView(),
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
		writeInternalError(w, err)
		return
	}
	writeJSON(w, stdhttp.StatusOK, h.enrich(srv).ToOwnerView())
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
		writeInternalError(w, err)
		return
	}
	writeJSON(w, stdhttp.StatusOK, h.enrich(srv).ToOwnerView())
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
		writeInternalError(w, err)
		return
	}
	writeJSON(w, stdhttp.StatusOK, h.enrich(s))
}

// ---- Listing images (owner-only) -----------------------------------------

func (h *ServerHandler) uploadIcon(w stdhttp.ResponseWriter, r *stdhttp.Request) {
	h.uploadImage(w, r, "icon", "server-icons", serverIconSize, serverIconSize)
}
func (h *ServerHandler) uploadBanner(w stdhttp.ResponseWriter, r *stdhttp.Request) {
	h.uploadImage(w, r, "banner", "server-banners", serverBannerW, serverBannerH)
}
func (h *ServerHandler) deleteIcon(w stdhttp.ResponseWriter, r *stdhttp.Request) {
	h.deleteImage(w, r, "icon")
}
func (h *ServerHandler) deleteBanner(w stdhttp.ResponseWriter, r *stdhttp.Request) {
	h.deleteImage(w, r, "banner")
}

// uploadImage handles the icon + banner upload: raw image bytes in the body
// → validate + resize + store in R2 → point the listing's key at it (owner
// only). `which` is "icon"|"banner", `namespace` the R2 prefix, w×h the
// target dimensions.
func (h *ServerHandler) uploadImage(w stdhttp.ResponseWriter, r *stdhttp.Request, which, namespace string, width, height int) {
	p := middleware.MustUser(r.Context())
	id, err := uuid.Parse(r.PathValue("id"))
	if err != nil {
		writeError(w, stdhttp.StatusBadRequest, "invalid id")
		return
	}
	if h.Avatar == nil || !h.Avatar.Configured() {
		writeError(w, stdhttp.StatusServiceUnavailable, "image uploads are not available")
		return
	}
	body, err := io.ReadAll(io.LimitReader(r.Body, avatar.MaxUploadBytes+1))
	if err != nil {
		writeError(w, stdhttp.StatusInternalServerError, "failed to read body")
		return
	}
	if len(body) > avatar.MaxUploadBytes {
		writeError(w, stdhttp.StatusRequestEntityTooLarge, "image too large")
		return
	}

	cur, err := h.Servers.GetByID(r.Context(), id)
	if errors.Is(err, server.ErrNotFound) {
		writeError(w, stdhttp.StatusNotFound, "not found")
		return
	}
	if err != nil {
		writeInternalError(w, err)
		return
	}
	// Owner check up front so a non-owner can't even spend an R2 upload.
	if cur.RegisteredBy == nil || *cur.RegisteredBy != p.UserID {
		writeError(w, stdhttp.StatusForbidden, "not the owner")
		return
	}
	prevKey := ""
	if which == "icon" && cur.IconStorageKey != nil {
		prevKey = *cur.IconStorageKey
	} else if which == "banner" && cur.BannerStorageKey != nil {
		prevKey = *cur.BannerStorageKey
	}

	key, err := h.Avatar.ProcessImage(r.Context(), namespace, id.String(), body, prevKey, width, height)
	switch {
	case errors.Is(err, avatar.ErrTooLarge):
		writeError(w, stdhttp.StatusRequestEntityTooLarge, "image too large")
		return
	case errors.Is(err, avatar.ErrUnsupportedImage):
		writeError(w, stdhttp.StatusBadRequest, "unsupported or invalid image")
		return
	case errors.Is(err, avatar.ErrNotConfigured):
		writeError(w, stdhttp.StatusServiceUnavailable, "image uploads are not available")
		return
	case err != nil:
		writeInternalError(w, err)
		return
	}

	srv, err := h.Servers.SetImageKey(r.Context(), id, p.UserID, which, &key)
	switch {
	case errors.Is(err, server.ErrNotOwner):
		_ = h.Avatar.Remove(r.Context(), key) // orphan cleanup
		writeError(w, stdhttp.StatusForbidden, "not the owner")
		return
	case errors.Is(err, server.ErrNotFound):
		writeError(w, stdhttp.StatusNotFound, "not found")
		return
	case err != nil:
		writeInternalError(w, err)
		return
	}
	writeJSON(w, stdhttp.StatusOK, h.enrich(srv).ToOwnerView())
}

func (h *ServerHandler) deleteImage(w stdhttp.ResponseWriter, r *stdhttp.Request, which string) {
	p := middleware.MustUser(r.Context())
	id, err := uuid.Parse(r.PathValue("id"))
	if err != nil {
		writeError(w, stdhttp.StatusBadRequest, "invalid id")
		return
	}
	cur, err := h.Servers.GetByID(r.Context(), id)
	if errors.Is(err, server.ErrNotFound) {
		writeError(w, stdhttp.StatusNotFound, "not found")
		return
	}
	if err != nil {
		writeInternalError(w, err)
		return
	}
	old := ""
	if which == "icon" && cur.IconStorageKey != nil {
		old = *cur.IconStorageKey
	} else if which == "banner" && cur.BannerStorageKey != nil {
		old = *cur.BannerStorageKey
	}

	srv, err := h.Servers.SetImageKey(r.Context(), id, p.UserID, which, nil)
	switch {
	case errors.Is(err, server.ErrNotOwner):
		writeError(w, stdhttp.StatusForbidden, "not the owner")
		return
	case errors.Is(err, server.ErrNotFound):
		writeError(w, stdhttp.StatusNotFound, "not found")
		return
	case err != nil:
		writeInternalError(w, err)
		return
	}
	if old != "" && h.Avatar != nil {
		_ = h.Avatar.Remove(r.Context(), old)
	}
	writeJSON(w, stdhttp.StatusOK, h.enrich(srv).ToOwnerView())
}
