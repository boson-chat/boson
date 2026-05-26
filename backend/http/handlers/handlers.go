package handlers

import (
	"encoding/json"
	stdhttp "net/http"
)

func writeJSON(w stdhttp.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

func writeError(w stdhttp.ResponseWriter, status int, msg string) {
	writeJSON(w, status, map[string]string{"error": msg})
}
