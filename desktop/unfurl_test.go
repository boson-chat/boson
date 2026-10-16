package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestParseOg(t *testing.T) {
	doc := `<head>
      <meta property="og:title" content="Hello &amp; World">
      <meta content="A nice post" name="og:description">
      <meta property="og:image" content="https://cdn.example.com/x.png">
      <meta property="og:site_name" content="Example">
    </head>`
	got := parseOg(doc, "https://example.com/p")
	want := OgCard{URL: "https://example.com/p", Title: "Hello & World", Description: "A nice post", Image: "https://cdn.example.com/x.png", SiteName: "Example"}
	if got != want {
		t.Fatalf("og tags: got %+v", got)
	}

	c := parseOg(`<head><title>Just a Title</title><meta name="description" content="desc"></head>`, "https://x.com")
	if c.Title != "Just a Title" || c.Description != "desc" || c.Image != "" {
		t.Fatalf("fallbacks: %+v", c)
	}

	if img := parseOg(`<meta property="og:image" content="/img/cover.jpg">`, "https://example.com/blog/post").Image; img != "https://example.com/img/cover.jpg" {
		t.Fatalf("relative image: %q", img)
	}

	m := parseOg(`<meta name="author" content="Jane Doe">
      <meta property="article:published_time" content="2025-02-20T10:00:00Z">`, "https://blog.example.com/p")
	if m.Author != "Jane Doe" || m.Date != "2025-02-20T10:00:00Z" {
		t.Fatalf("meta author/date: %+v", m)
	}

	yt := strings.Repeat("x", 5000) + `<script type="application/ld+json">
      {"@type":"VideoObject","author":{"@type":"Person","name":"abe's projects"},"uploadDate":"2025-02-20T10:00:44-08:00"}
      </script><meta property="og:title" content="I built my ideal mini computer">`
	y := parseOg(yt, "https://www.youtube.com/watch?v=x")
	if y.Title != "I built my ideal mini computer" || y.Author != "abe's projects" || y.Date != "2025-02-20T10:00:44-08:00" {
		t.Fatalf("json-ld: %+v", y)
	}
}

func TestAbsolutize(t *testing.T) {
	cases := map[[2]string]string{
		{"https://a.com/x.png", "https://b.com"}: "https://a.com/x.png",
		{"/x.png", "https://b.com/p"}:            "https://b.com/x.png",
		{"javascript:alert(1)", "https://b.com"}: "",
		{"", "https://b.com"}:                    "",
	}
	for in, want := range cases {
		if got := absolutize(in[0], in[1]); got != want {
			t.Errorf("absolutize(%q, %q) = %q, want %q", in[0], in[1], got, want)
		}
	}
}

func TestIsBlockedHost(t *testing.T) {
	for _, h := range []string{"localhost", "127.0.0.1", "0.0.0.0", "::1", "[::1]", "10.0.0.5", "192.168.1.2", "172.16.0.1", "169.254.1.1", "foo.local", "100.64.0.1", "fd00::1", "fe80::1"} {
		if !isBlockedHost(h) {
			t.Errorf("%s should be blocked", h)
		}
	}
	for _, h := range []string{"example.com", "youtube.com", "8.8.8.8", "172.15.0.1", "172.32.0.1"} {
		if isBlockedHost(h) {
			t.Errorf("%s should be allowed", h)
		}
	}
}

func TestUnfurlRefusesPrivateTargets(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html")
		_, _ = w.Write([]byte(`<meta property="og:title" content="local">`))
	}))
	defer srv.Close()
	s := NewUnfurlService(false)
	if c := s.Fetch(context.Background(), srv.URL); c != nil {
		t.Fatalf("fetched a loopback URL: %+v", c)
	}
	// A public-looking name that resolves to loopback is refused at connect time.
	port := srv.URL[strings.LastIndex(srv.URL, ":")+1:]
	if c := s.Fetch(context.Background(), "http://localtest.me:"+port+"/"); c != nil {
		t.Fatalf("followed a name resolving to loopback: %+v", c)
	}
}

func TestUnfurlHostMapReachesStub(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		_, _ = w.Write([]byte(`<meta property="og:title" content="stub">`))
	}))
	defer srv.Close()
	t.Setenv("BOSON_E2E_HOST_MAP", "unfurl.e2e.test=127.0.0.1")
	port := srv.URL[strings.LastIndex(srv.URL, ":")+1:]
	if c := NewUnfurlService(true).Fetch(context.Background(), "http://unfurl.e2e.test:"+port+"/"); c == nil || c.Title != "stub" {
		t.Fatalf("host map: %+v", c)
	}
	// Without the dev-build allowance the map is ignored.
	if c := NewUnfurlService(false).Fetch(context.Background(), "http://unfurl.e2e.test:"+port+"/"); c != nil {
		t.Fatalf("host map honoured in a release build: %+v", c)
	}
}

func TestSpotifyEmbedURL(t *testing.T) {
	if e, k, ok := spotifyEmbedURL("https://open.spotify.com/track/abc123"); !ok || e != "https://open.spotify.com/embed/track/abc123" || k != "track" {
		t.Fatalf("track: %s %s %v", e, k, ok)
	}
	if e, _, _ := spotifyEmbedURL("https://open.spotify.com/intl-de/album/xyz"); e != "https://open.spotify.com/embed/album/xyz" {
		t.Fatalf("intl: %s", e)
	}
	if _, k, _ := spotifyEmbedURL("https://open.spotify.com/embed/playlist/pl1"); k != "playlist" {
		t.Fatalf("embed path: %s", k)
	}
	for _, bad := range []string{"https://open.spotify.com/user/someone", "https://evil.example.com/track/abc"} {
		if _, _, ok := spotifyEmbedURL(bad); ok {
			t.Errorf("%s accepted", bad)
		}
	}
}

func TestParseSpotifyNextData(t *testing.T) {
	wrap := func(entity any) string {
		b, _ := json.Marshal(map[string]any{"props": map[string]any{"pageProps": map[string]any{"state": map[string]any{"data": map[string]any{"entity": entity}}}}})
		return `<html><script id="__NEXT_DATA__" type="application/json">` + string(b) + `</script></html>`
	}
	track := parseSpotifyNextData(wrap(map[string]any{
		"type": "track", "title": "Speak To Me", "artists": []any{map[string]any{"name": "Pink Floyd"}}, "duration": 234000,
		"audioPreview":   map[string]any{"url": "https://p.scdn.co/mp3-preview/abc"},
		"visualIdentity": map[string]any{"image": []any{map[string]any{"url": "https://img/64", "maxWidth": 64}, map[string]any{"url": "https://img/640", "maxWidth": 640}}},
	}), "https://open.spotify.com/track/x")
	if track == nil || track.Title != "Speak To Me" || track.Subtitle != "Pink Floyd" || track.Cover != "https://img/640" || track.PreviewURL != "https://p.scdn.co/mp3-preview/abc" || track.DurationMs != 234000 {
		t.Fatalf("track: %+v", track)
	}
	pl := parseSpotifyNextData(wrap(map[string]any{
		"type": "playlist", "title": "Today’s Top Hits", "subtitle": "Spotify",
		"coverArt": map[string]any{"sources": []any{map[string]any{"url": "https://c/300", "width": 300}, map[string]any{"url": "https://c/64", "width": 64}}},
		"trackList": []any{
			map[string]any{"title": "A", "subtitle": "Artist A", "duration": 200000, "audioPreview": map[string]any{"url": "https://p/a"}},
			map[string]any{"title": "B", "subtitle": "Artist B", "duration": 180000},
			map[string]any{"title": "", "subtitle": "skip me"},
		},
	}), "https://open.spotify.com/playlist/x")
	if pl == nil || pl.Cover != "https://c/300" || pl.Subtitle != "Spotify" || len(pl.Tracks) != 2 ||
		pl.Tracks[0] != (SpotifyTrack{Title: "A", Artist: "Artist A", DurationMs: 200000, PreviewURL: "https://p/a"}) || pl.Tracks[1].PreviewURL != "" {
		t.Fatalf("playlist: %+v", pl)
	}
	if parseSpotifyNextData("<html>nope</html>", "u") != nil || parseSpotifyNextData(wrap(nil), "u") != nil {
		t.Fatal("expected nil without data")
	}
}
