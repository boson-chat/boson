package http

import (
	"context"
	"encoding/json"
	"fmt"
	stdhttp "net/http"
	"time"

	"github.com/boson-chat/boson/backend/config"
	"github.com/boson-chat/boson/backend/http/handlers"
	"github.com/boson-chat/boson/backend/http/middleware"
	"github.com/boson-chat/boson/backend/internal/db"
	"github.com/boson-chat/boson/backend/internal/logger"
	serversvc "github.com/boson-chat/boson/backend/internal/services/server"
	serversvc_dns "github.com/boson-chat/boson/backend/internal/services/server/dns"
	sessionsvc "github.com/boson-chat/boson/backend/internal/services/session"
	"github.com/boson-chat/boson/backend/internal/services/user"
)

func StartServerWithContext(ctx context.Context) error {
	cfg := config.LoadConfigOrPanic()
	database := db.NewDatabase(cfg.DBConfig)

	// Repositories
	userRepo := user.NewUserRepository(database)
	serverRepo := serversvc.NewServerRepository(database)
	sessionRepo := sessionsvc.NewRepository(database)

	// Services
	userService := user.NewUserService(userRepo)
	// Pick the verifier based on the SKIP_DNS_VERIFY flag — the
	// dev-mode bypass returns success without touching the network,
	// so localhost-only registrations don't need a real TXT record.
	// Production deployments leave the flag off (default) and we get
	// the standard three-resolver verifier.
	var verifier serversvc_dns.Verifier
	if cfg.AppConfig.SkipDNSVerify {
		verifier = serversvc_dns.AlwaysSucceedVerifier{}
	} else {
		verifier = serversvc_dns.NewVerifier()
	}
	serverService := serversvc.NewServerServiceWithVerifier(serverRepo, verifier)
	sessionService := sessionsvc.NewService(sessionRepo)

	// Handlers
	meHandler := handlers.NewMeHandler(userService)
	serverHandler := handlers.NewServerHandler(serverService)
	sessionHandler := handlers.NewSessionHandler(sessionService)

	// Public routes — health + read-only directory browsing. Guest users
	// (no Supabase session) hit these without an Authorization header.
	publicMux := stdhttp.NewServeMux()
	publicMux.HandleFunc("GET /health", healthHandler(database))
	serverHandler.RegisterPublic(publicMux)

	// Protected routes — everything that needs an authenticated principal.
	// Server creation lives here so we can record the registering user.
	protectedMux := stdhttp.NewServeMux()
	meHandler.Register(protectedMux)
	serverHandler.RegisterProtected(protectedMux)
	sessionHandler.Register(protectedMux)

	root := buildRouter(publicMux, protectedMux, middleware.RequireAuth(cfg.AuthConfig))

	addr := fmt.Sprintf(":%d", cfg.AppConfig.Port)
	srv := &stdhttp.Server{
		Addr:              addr,
		Handler:           middleware.CORS(cfg.AppConfig.AllowedOrigins)(root),
		ReadHeaderTimeout: 5 * time.Second,
	}

	log := logger.FromCtx(ctx)
	log.Info().Str("addr", addr).Msg("HTTP server listening")
	return srv.ListenAndServe()
}

// buildRouter wires the public and protected muxes onto a single root mux,
// applying `auth` only to routes that need an authenticated principal.
//
// Method-aware patterns at the root level direct GET /servers and
// GET /servers/{id} to the public mux (the IRC directory is a read-only
// public resource — guests browse without signing in) while POST /servers
// and every other path fall through to the auth-wrapped protected mux.
// Extracted so tests can verify the route-level auth gating without
// standing up the full server.
func buildRouter(
	publicMux, protectedMux *stdhttp.ServeMux,
	auth func(stdhttp.Handler) stdhttp.Handler,
) *stdhttp.ServeMux {
	authedProtected := auth(protectedMux)
	root := stdhttp.NewServeMux()
	root.Handle("/health", publicMux)
	root.Handle("GET /servers", publicMux)
	// GET /servers/me MUST be registered before the generic
	// GET /servers/{id} below — otherwise the literal "me" segment falls
	// into the {id} pattern, the public handler tries uuid.Parse("me"),
	// and the caller gets back 400 "invalid id". The owner-scoped list
	// route lives on the protected mux because it leaks pending
	// verification tokens (only to the row's owner, but still — auth
	// required).
	root.Handle("GET /servers/me", authedProtected)
	root.Handle("GET /servers/{id}", publicMux)
	root.Handle("POST /servers", authedProtected)
	root.Handle("/", authedProtected)
	return root
}

func healthHandler(database *db.DB) stdhttp.HandlerFunc {
	return func(w stdhttp.ResponseWriter, r *stdhttp.Request) {
		sqlDB, err := database.DB.DB()
		if err != nil {
			writeJSON(w, stdhttp.StatusServiceUnavailable, map[string]string{"status": "db_unavailable"})
			return
		}
		if err := sqlDB.PingContext(r.Context()); err != nil {
			writeJSON(w, stdhttp.StatusServiceUnavailable, map[string]string{"status": "db_ping_failed", "error": err.Error()})
			return
		}
		writeJSON(w, stdhttp.StatusOK, map[string]string{"status": "ok"})
	}
}

func writeJSON(w stdhttp.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}
