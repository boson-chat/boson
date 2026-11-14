package handlers

import (
	"crypto/sha256"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"io"
	stdhttp "net/http"
	"strings"

	"github.com/boson-chat/boson/backend/internal/configfile"
	"github.com/boson-chat/boson/backend/internal/services/nickclaim"
)

// InternalTokenHeader carries INTERNAL_TOKEN (as on the auth service);
// "Authorization: Bearer <token>" is accepted too.
const InternalTokenHeader = "X-Internal-Token"

// InternalHandler is the internal listener (INTERNAL_ADDR, default :3001,
// compose network only):
//
//	GET  /healthz
//	GET  /internal/config/status       no token (like auth's), + nick_claim summary
//	GET  /internal/nick-claims/status  X-Internal-Token
//	POST /internal/nick-claims/test    X-Internal-Token
type InternalHandler struct {
	NickClaims   nickclaim.RuntimeImpl
	Token        string
	ConfigStatus func() configfile.Status // nil: BOSON_CONFIG unset
}

func NewInternalHandler(rt nickclaim.RuntimeImpl, token string, status func() configfile.Status) *InternalHandler {
	return &InternalHandler{NickClaims: rt, Token: token, ConfigStatus: status}
}

func (h *InternalHandler) Register(mux *stdhttp.ServeMux) {
	mux.HandleFunc("GET /healthz", func(w stdhttp.ResponseWriter, _ *stdhttp.Request) {
		writeJSON(w, stdhttp.StatusOK, map[string]string{"status": "ok"})
	})
	mux.HandleFunc("GET /internal/config/status", h.configStatus)
	mux.HandleFunc("GET /internal/nick-claims/status", h.internalOnly(h.nickClaimStatus))
	mux.HandleFunc("POST /internal/nick-claims/test", h.internalOnly(h.nickClaimTest))
}

func (h *InternalHandler) internalOnly(next stdhttp.HandlerFunc) stdhttp.HandlerFunc {
	want := sha256.Sum256([]byte(h.Token))
	return func(w stdhttp.ResponseWriter, r *stdhttp.Request) {
		if h.Token == "" {
			writeError(w, stdhttp.StatusServiceUnavailable, "internal_api_disabled")
			return
		}
		tok := r.Header.Get(InternalTokenHeader)
		if tok == "" {
			if a := r.Header.Get("Authorization"); len(a) > 7 && strings.EqualFold(a[:7], "Bearer ") {
				tok = strings.TrimSpace(a[7:])
			}
		}
		got := sha256.Sum256([]byte(tok))
		if subtle.ConstantTimeCompare(got[:], want[:]) != 1 {
			writeError(w, stdhttp.StatusUnauthorized, "unauthorized")
			return
		}
		next(w, r)
	}
}

// configStatus is the stack config contract's status plus this
// service's nick_claim summary:
//
//	{path, loaded_at, file_mtime, ok, error?, restart_required,
//	 nick_claim: {enabled, worker: stopped|running|error, last_poll_at, last_error?}}
func (h *InternalHandler) configStatus(w stdhttp.ResponseWriter, _ *stdhttp.Request) {
	st := configfile.Status{OK: true, RestartRequired: []string{}}
	if h.ConfigStatus != nil {
		st = h.ConfigStatus()
	}
	body := struct {
		configfile.Status
		NickClaim nickclaim.Summary `json:"nick_claim"`
	}{st, h.NickClaims.Summary()}
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, stdhttp.StatusOK, body)
}

func (h *InternalHandler) nickClaimStatus(w stdhttp.ResponseWriter, r *stdhttp.Request) {
	st, err := h.NickClaims.Status(r.Context())
	if err != nil {
		writeInternalError(w, err)
		return
	}
	writeJSON(w, stdhttp.StatusOK, st)
}

// nickClaimTestRequest: an empty body tests the inbound config in use.
// Fields set under inbound override it (unsaved values from the panel's
// form). The stored password is reused only for the host in use; testing
// another host needs its password in the request, so the stored one is
// never sent anywhere new.
type nickClaimTestRequest struct {
	Inbound *struct {
		Protocol *string `json:"protocol"`
		Host     *string `json:"host"`
		Port     *int    `json:"port"`
		TLS      *bool   `json:"tls"`
		User     *string `json:"user"`
		Password *string `json:"password"`
	} `json:"inbound"`
}

func (h *InternalHandler) nickClaimTest(w stdhttp.ResponseWriter, r *stdhttp.Request) {
	var req nickClaimTestRequest
	if err := json.NewDecoder(io.LimitReader(r.Body, 64<<10)).Decode(&req); err != nil && !errors.Is(err, io.EOF) {
		writeError(w, stdhttp.StatusBadRequest, "invalid json")
		return
	}
	cur := h.NickClaims.Settings().Inbound
	cfg := cur
	if in := req.Inbound; in != nil {
		if in.Protocol != nil && !strings.EqualFold(strings.TrimSpace(*in.Protocol), "pop3") {
			writeError(w, stdhttp.StatusBadRequest, "inbound.protocol must be pop3")
			return
		}
		if in.Host != nil {
			cfg.Host = strings.TrimSpace(*in.Host)
		}
		if in.Port != nil {
			if *in.Port < 1 || *in.Port > 65535 {
				writeError(w, stdhttp.StatusBadRequest, "inbound.port must be between 1 and 65535")
				return
			}
			cfg.Port = *in.Port
		}
		if in.TLS != nil {
			cfg.UseTLS = *in.TLS
		}
		if in.User != nil {
			cfg.User = strings.TrimSpace(*in.User)
		}
		switch {
		case in.Password != nil:
			cfg.Password = *in.Password
		case !strings.EqualFold(cfg.Host, cur.Host):
			cfg.Password = ""
		}
	}
	writeJSON(w, stdhttp.StatusOK, h.NickClaims.TestInbound(r.Context(), cfg))
}
