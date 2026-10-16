package main

import (
	"bytes"
	"io/fs"
	"net/http"
)

// shellMarker tells the renderer it's running in the Wails shell. The page's
// origin says so in a desktop window (wails://localhost, http://wails.localhost)
// but not in a server-mode build, which is served from http://localhost:<port>.
const shellMarker = `<meta name="boson-shell" content="wails">`

// assetHandler serves the renderer build, with shellMarker added to index.html.
func assetHandler(dist fs.FS) http.Handler {
	files := http.FileServerFS(dist)
	index, err := fs.ReadFile(dist, "index.html")
	if err == nil {
		index = bytes.Replace(index, []byte("<head>"), []byte("<head>"+shellMarker), 1)
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if err == nil && (r.URL.Path == "/" || r.URL.Path == "/index.html") {
			w.Header().Set("Content-Type", "text/html; charset=utf-8")
			_, _ = w.Write(index)
			return
		}
		files.ServeHTTP(w, r)
	})
}
