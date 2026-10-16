package main

import (
	"context"
	"io/fs"
	"net"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/wailsapp/wails/v3/pkg/application"
)

// YouTubeService serves the YouTube wrapper page (the renderer's
// public/youtube-embed.html and .js) over loopback http. YouTube refuses to
// play in a page whose origin is wails://localhost (error 153), so the
// renderer frames the wrapper from here and the wrapper frames YouTube.
// Only those two files are served. The renderer gets the origin to use
// from WrapperOrigin (platform/wails.ts → Embed.tsx).
type YouTubeService struct {
	dist   fs.FS
	host   string
	origin string
	srv    *http.Server
}

// youtubeWrapperHost: a *.localhost name resolves to loopback in the
// webview without any DNS, and isn't a bare loopback address, which YouTube
// refuses for some (label) videos.
const youtubeWrapperHost = "youtube-embed.localhost"

func NewYouTubeService(dist fs.FS) *YouTubeService {
	return &YouTubeService{dist: dist, host: youtubeWrapperHost}
}

func (y *YouTubeService) WrapperOrigin() string { return y.origin }

func (y *YouTubeService) ServiceStartup(context.Context, application.ServiceOptions) error {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return nil // no wrapper: the renderer embeds YouTube directly
	}
	port := ln.Addr().(*net.TCPAddr).Port
	y.origin = "http://" + y.host + ":" + strconv.Itoa(port)
	files := http.FileServerFS(y.dist)
	y.srv = &http.Server{
		ReadHeaderTimeout: 5 * time.Second,
		Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			host, _, _ := net.SplitHostPort(r.Host)
			if !strings.EqualFold(host, y.host) && host != "127.0.0.1" {
				http.NotFound(w, r)
				return
			}
			if r.URL.Path != "/youtube-embed.html" && r.URL.Path != "/youtube-embed.js" {
				http.NotFound(w, r)
				return
			}
			files.ServeHTTP(w, r)
		}),
	}
	go func() { _ = y.srv.Serve(ln) }()
	return nil
}

func (y *YouTubeService) ServiceShutdown() error {
	if y.srv != nil {
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		_ = y.srv.Shutdown(ctx)
	}
	return nil
}
