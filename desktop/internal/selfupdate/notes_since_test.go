package selfupdate

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestFetchNotesSince(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/repos/o/r/releases" {
			http.NotFound(w, r)
			return
		}
		w.Write([]byte(`[
			{"tag_name":"v0.62.0","body":"too new"},
			{"tag_name":"v0.61.1","body":"b611"},
			{"tag_name":"v0.61.0-rc.1","body":"pre","prerelease":true},
			{"tag_name":"v0.60.0","body":"b600"},
			{"tag_name":"v0.61.0","body":"b610"},
			{"tag_name":"v0.59.1","body":"draft","draft":true},
			{"tag_name":"v0.59.0","body":"installed"},
			{"tag_name":"v0.58.0","body":"older"}
		]`))
	}))
	defer srv.Close()
	got, err := FetchNotesSince(context.Background(), srv.Client(), srv.URL+"/repos/o/r/releases/latest", "0.59.0", "0.61.1")
	if err != nil {
		t.Fatal(err)
	}
	var vs []string
	for _, r := range got {
		vs = append(vs, r.Version+"="+r.Notes)
	}
	if want := "0.61.1=b611 0.61.0=b610 0.60.0=b600"; strings.Join(vs, " ") != want {
		t.Fatalf("got %q, want %q", strings.Join(vs, " "), want)
	}
}

func TestFetchNotesSinceOtherFeed(t *testing.T) {
	got, err := FetchNotesSince(context.Background(), http.DefaultClient, "http://127.0.0.1:1/feed.json", "0.1.0", "0.2.0")
	if err != nil || got != nil {
		t.Fatalf("a non-GitHub feed: got %v, %v; want nil, nil", got, err)
	}
}

func TestCombinedNotes(t *testing.T) {
	body := func(items ...string) string {
		return "## [x](y) (2026-11-15)\n\n### Bug Fixes\n\n* " + strings.Join(items, " ([#1](u)) ([abc](u))\n* ") + " ([#1](u))\n"
	}
	list := []VersionNotes{
		{Version: "0.61.1", Notes: body("phone composer")},
		{Version: "0.61.0", Notes: body("a", "b", "c")},
		{Version: "0.60.0", Notes: ""},
	}
	got := CombinedNotes(list, 2, 8)
	want := "v0.61.1\nBug Fixes\n• phone composer\n\nv0.61.0\nBug Fixes\n• a\n• b\n…and 1 more\n\nv0.60.0"
	if got != want {
		t.Fatalf("got:\n%s\nwant:\n%s", got, want)
	}
	if got := CombinedNotes(list, 2, 1); !strings.HasSuffix(got, "\n\n…and 2 earlier releases") || !strings.HasPrefix(got, "v0.61.1\n") {
		t.Fatalf("capped: got:\n%s", got)
	}
}
