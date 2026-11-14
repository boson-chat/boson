package main

import (
	"bytes"
	"context"
	"encoding/base64"
	"image"
	"image/color"
	"image/png"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func pngOf(t *testing.T, w, h int) []byte {
	t.Helper()
	img := image.NewRGBA(image.Rect(0, 0, w, h))
	img.Set(0, 0, color.RGBA{R: 200, A: 255})
	var b bytes.Buffer
	if err := png.Encode(&b, img); err != nil {
		t.Fatal(err)
	}
	return b.Bytes()
}

// A WebP header: RIFF/WEBP with a VP8X chunk giving the canvas size.
func webpVP8X(w, h int) []byte {
	b := []byte("RIFF\x00\x00\x00\x00WEBPVP8X\x0a\x00\x00\x00")
	w--
	h--
	b = append(b, 0, 0, 0, 0, byte(w), byte(w>>8), byte(w>>16), byte(h), byte(h>>8), byte(h>>16))
	return append(b, make([]byte, 16)...)
}

func brandingServer(t *testing.T) *httptest.Server {
	t.Helper()
	logo := pngOf(t, 64, 64)
	huge := pngOf(t, 4097, 2)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/v1/branding":
			if r.Header.Get("If-None-Match") == `"v1"` {
				w.WriteHeader(http.StatusNotModified)
				return
			}
			w.Header().Set("ETag", `"v1"`)
			_, _ = w.Write([]byte(`{"version":1,"colors":{"accent":"#7c3aed"}}`))
		case "/big.json":
			_, _ = w.Write([]byte(`{"pad":"` + strings.Repeat("x", brandingDocMax) + `"}`))
		case "/logo.png":
			// The Content-Type lies; the bytes decide.
			w.Header().Set("Content-Type", "text/html")
			_, _ = w.Write(logo)
		case "/huge.png":
			_, _ = w.Write(huge)
		case "/logo.svg":
			_, _ = w.Write([]byte(`<?xml version="1.0"?><!-- mark --><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"/>`))
		case "/page.html":
			_, _ = w.Write([]byte(`<!doctype html><html><body><svg></svg></body></html>`))
		case "/wide.webp":
			_, _ = w.Write(webpVP8X(4096, 300))
		case "/toowide.webp":
			_, _ = w.Write(webpVP8X(5000, 300))
		case "/large.png":
			_, _ = w.Write(append(pngOf(t, 8, 8), make([]byte, brandingImageMax)...))
		case "/redirect":
			http.Redirect(w, r, "http://10.0.0.1/logo.png", http.StatusFound)
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(srv.Close)
	return srv
}

func TestBrandingFetchDocument(t *testing.T) {
	srv := brandingServer(t)
	s := NewBrandingService(true)
	ctx := context.Background()

	got := s.Fetch(ctx, srv.URL+"/v1/branding", "")
	if got.Status != 200 || got.ETag != `"v1"` || !strings.Contains(got.Body, "#7c3aed") || got.Error != "" {
		t.Fatalf("fetch: %+v", got)
	}
	if got := s.Fetch(ctx, srv.URL+"/v1/branding", `"v1"`); got.Status != http.StatusNotModified || got.Body != "" {
		t.Fatalf("revalidate: %+v", got)
	}
	if got := s.Fetch(ctx, srv.URL+"/big.json", ""); got.Error == "" || got.Body != "" {
		t.Fatalf("over 16 KB: %+v", got)
	}
	if got := s.Fetch(ctx, srv.URL+"/missing", ""); got.Status != 404 || got.Body != "" {
		t.Fatalf("404: %+v", got)
	}
	if got := s.Fetch(ctx, "ftp://example.com/x", ""); got.Error == "" || got.Status != 0 {
		t.Fatalf("scheme: %+v", got)
	}
}

func TestBrandingURLPolicy(t *testing.T) {
	release := NewBrandingService(false)
	dev := NewBrandingService(true)
	ctx := context.Background()
	for _, raw := range []string{
		"http://example.com/logo.png",                    // http outside dev
		"http://127.0.0.1:9/logo.png",                    // loopback outside dev
		"https://127.0.0.1/logo.png",                     // loopback outside dev
		"https://10.1.2.3/logo.png",                      // private
		"https://192.168.1.1/logo.png",                   // private
		"https://169.254.169.254/latest",                 // link-local (cloud metadata)
		"https://printer.local/logo.png",                 // mDNS
		"https://user:pw@example.com/x",                  // credentials
		"javascript:alert(1)",                            // not a URL we fetch
		"https://" + strings.Repeat("a", 2100) + ".com/", // too long
	} {
		if got := release.Image(ctx, raw); got.Error == "" {
			t.Errorf("release build fetched %s", raw)
		}
	}
	if !dev.Policy().AllowLoopbackHTTP || release.Policy().AllowLoopbackHTTP {
		t.Fatal("policy")
	}
	// Dev builds may reach loopback, never the LAN.
	if got := dev.Image(ctx, "http://10.0.0.1/logo.png"); got.Error == "" {
		t.Fatal("dev build fetched a private address over http")
	}
	if got := dev.Image(ctx, "https://10.0.0.1/logo.png"); got.Error == "" {
		t.Fatal("dev build fetched a private address")
	}
}

func TestBrandingImage(t *testing.T) {
	srv := brandingServer(t)
	s := NewBrandingService(true)
	ctx := context.Background()

	got := s.Image(ctx, srv.URL+"/logo.png")
	if got.Error != "" || got.ContentType != "image/png" {
		t.Fatalf("png: %+v", got)
	}
	if b, err := base64.StdEncoding.DecodeString(got.Data); err != nil || !bytes.HasPrefix(b, []byte("\x89PNG")) {
		t.Fatalf("png bytes: %v", err)
	}
	if got := s.Image(ctx, srv.URL+"/logo.svg"); got.Error != "" || got.ContentType != "image/svg+xml" {
		t.Fatalf("svg: %+v", got)
	}
	if got := s.Image(ctx, srv.URL+"/wide.webp"); got.Error != "" || got.ContentType != "image/webp" {
		t.Fatalf("webp: %+v", got)
	}
	for _, p := range []string{"/huge.png", "/toowide.webp", "/large.png", "/page.html", "/missing", "/redirect"} {
		if got := s.Image(ctx, srv.URL+p); got.Error == "" || got.Data != "" {
			t.Errorf("%s: accepted %+v", p, got.ContentType)
		}
	}
}

func TestWebpSize(t *testing.T) {
	// VP8L: signature 0x2f, then 14-bit width-1 / height-1.
	vp8l := []byte("RIFF\x00\x00\x00\x00WEBPVP8L\x00\x00\x00\x00")
	bits := uint32(99) | uint32(49)<<14
	vp8l = append(vp8l, 0x2f, byte(bits), byte(bits>>8), byte(bits>>16), byte(bits>>24))
	vp8l = append(vp8l, make([]byte, 16)...)
	if w, h, err := webpSize(vp8l); err != nil || w != 100 || h != 50 {
		t.Fatalf("vp8l: %d %d %v", w, h, err)
	}
	// VP8 (lossy): frame tag, start code, 14-bit sizes.
	vp8 := []byte("RIFF\x00\x00\x00\x00WEBPVP8 \x00\x00\x00\x00")
	vp8 = append(vp8, 0, 0, 0, 0x9d, 0x01, 0x2a, 0x40, 0x01, 0xf0, 0x00)
	vp8 = append(vp8, make([]byte, 16)...)
	if w, h, err := webpSize(vp8); err != nil || w != 320 || h != 240 {
		t.Fatalf("vp8: %d %d %v", w, h, err)
	}
	if _, _, err := webpSize([]byte("RIFF\x00\x00\x00\x00WEBPJUNK" + strings.Repeat("\x00", 20))); err == nil {
		t.Fatal("unknown chunk accepted")
	}
}

func TestIsSVG(t *testing.T) {
	for in, want := range map[string]bool{
		`<svg xmlns="http://www.w3.org/2000/svg"/>`:                        true,
		"\xef\xbb\xbf<?xml version=\"1.0\"?>\n<!DOCTYPE svg><svg>\n</svg>": true,
		`<svgx/>`:                   false,
		`<html><svg/></html>`:       false,
		`<?xml version="1.0"?><x/>`: false,
		`<!-- unterminated <svg/>`:  false,
	} {
		if got := isSVG([]byte(in)); got != want {
			t.Errorf("isSVG(%q) = %v", in, got)
		}
	}
}
