package handlers

import (
	stdhttp "net/http"

	"github.com/boson-chat/boson/backend/internal/services/nickclaim"
)

// PublicConfigHandler serves GET /config: the network's capabilities the
// client adapts to. No auth — it reveals only on/off switches.
//
//	{"nick_claim": false}
type PublicConfigHandler struct {
	Claims nickclaim.ServiceImpl
}

func NewPublicConfigHandler(claims nickclaim.ServiceImpl) *PublicConfigHandler {
	return &PublicConfigHandler{Claims: claims}
}

func (h *PublicConfigHandler) Register(mux *stdhttp.ServeMux) {
	mux.HandleFunc("GET /config", h.get)
}

type publicConfigResponse struct {
	// NickClaim: automatic NickServ registration on other networks
	// (POST /me/nick-claims) is available.
	NickClaim bool `json:"nick_claim"`
}

func (h *PublicConfigHandler) get(w stdhttp.ResponseWriter, _ *stdhttp.Request) {
	// Settings can flip on a config reload; don't let anything cache it.
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, stdhttp.StatusOK, publicConfigResponse{NickClaim: h.Claims.Enabled()})
}
