package handlers

import (
	"encoding/json"
	stdhttp "net/http"

	"github.com/rs/zerolog/log"
)

func writeJSON(w stdhttp.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json")
	// 204 No Content must not carry a body — encoding `null` there is
	// non-conformant and trips strict HTTP clients/proxies.
	if status == stdhttp.StatusNoContent || body == nil {
		w.WriteHeader(status)
		return
	}
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

func writeError(w stdhttp.ResponseWriter, status int, msg string) {
	writeJSON(w, status, map[string]string{"error": msg})
}

// writeInternalError logs the underlying error server-side and returns a
// generic 500 to the client. Raw err.Error() strings leak GORM/SQL/driver
// internals (and sometimes DB host/port) across the API boundary, so they
// must never reach the response body.
func writeInternalError(w stdhttp.ResponseWriter, err error) {
	log.Error().Err(err).Msg("internal server error")
	writeError(w, stdhttp.StatusInternalServerError, "internal server error")
}
