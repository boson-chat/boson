package main

import (
	"bytes"
	"io/fs"
	"net/http"
	"strings"
)

// shellMarker tells the renderer it's running in the Wails shell. The page's
// origin says so in a desktop window (wails://localhost, http://wails.localhost)
// but not in a server-mode build, which is served from http://localhost:<port>.
const shellMarker = `<meta name="boson-shell" content="wails">`

// filesRoutePrefix is where FilesService answers on the app's own origin.
const filesRoutePrefix = "/_boson/files/"

// assetHandler serves the renderer build, with shellMarker added to index.html,
// files (FilesService: uploads and previews, desktop only) under
// /_boson/files/ and the image cache (ImageCacheService) at /_boson/img.
func assetHandler(dist fs.FS, uploads http.Handler, images http.Handler) http.Handler {
	files := http.FileServerFS(dist)
	index, err := fs.ReadFile(dist, "index.html")
	if err == nil {
		index = bytes.Replace(index, []byte("<head>"), []byte("<head>"+shellMarker), 1)
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if uploads != nil && strings.HasPrefix(r.URL.Path, filesRoutePrefix) {
			uploads.ServeHTTP(w, r)
			return
		}
		if images != nil && r.URL.Path == imageRoute {
			images.ServeHTTP(w, r)
			return
		}
		if err == nil && (r.URL.Path == "/" || r.URL.Path == "/index.html") {
			w.Header().Set("Content-Type", "text/html; charset=utf-8")
			_, _ = w.Write(index)
			return
		}
		files.ServeHTTP(w, r)
	})
}
