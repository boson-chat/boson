package handlers

import (
	"encoding/json"
	"errors"
	stdhttp "net/http"
	"strconv"

	"github.com/boson-chat/boson/backend/http/middleware"
	"github.com/boson-chat/boson/backend/internal/services/server"

	"github.com/google/uuid"
)

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
// principal — currently just server creation, which records the registering
// user via middleware.MustUser.
func (h *ServerHandler) RegisterProtected(mux *stdhttp.ServeMux) {
	mux.HandleFunc("POST /servers", h.create)
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

	results, err := h.Servers.List(r.Context(), server.ListFilter{
		Query:       q.Get("q"),
		Language:    q.Get("lang"),
		IncludeNSFW: q.Get("nsfw") == "true",
		Sort:        q.Get("sort"),
		Limit:       limit,
		Offset:      offset,
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
	writeJSON(w, stdhttp.StatusCreated, srv)
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
