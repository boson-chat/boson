package main

import (
	"io"
	"net/http"
	"net/url"
	"strings"
	"testing"
	"time"
)

func TestSSOLoopbackCode(t *testing.T) {
	s := NewSSOService()
	b, err := s.Begin()
	if err != nil {
		t.Fatal(err)
	}
	u, _ := url.Parse(b.RedirectURI)
	if u.Hostname() != "127.0.0.1" || u.Path != "/callback" || u.Query().Get("s") == "" {
		t.Fatalf("redirect %q", b.RedirectURI)
	}
	// A request without the flow's state is refused and changes nothing.
	bad := *u
	bad.RawQuery = "code=bsc_evil&s=wrong"
	if r, err := http.Get(bad.String()); err != nil || r.StatusCode != http.StatusNotFound {
		t.Fatalf("wrong state: %v %v", r, err)
	}
	// The auth service keeps return_to's query and adds code.
	good := *u
	q := u.Query()
	q.Set("code", "bsc_123")
	good.RawQuery = q.Encode()
	r, err := http.Get(good.String())
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(r.Body)
	if !strings.Contains(string(body), "close this tab") {
		t.Errorf("page: %s", body)
	}
	got := s.Wait(b.ID)
	if got.Code != "bsc_123" || got.Error != "" {
		t.Fatalf("result %+v", got)
	}
	// The listener is gone afterwards.
	time.Sleep(50 * time.Millisecond)
	if _, err := http.Get(good.String()); err == nil {
		t.Error("listener still up")
	}
}

func TestSSOLoopbackErrorAndCancel(t *testing.T) {
	s := NewSSOService()
	b, _ := s.Begin()
	u, _ := url.Parse(b.RedirectURI)
	q := u.Query()
	q.Set("error", "access_denied")
	q.Set("error_description", "You cancelled.")
	u.RawQuery = q.Encode()
	if _, err := http.Get(u.String()); err != nil {
		t.Fatal(err)
	}
	if got := s.Wait(b.ID); got.Error != "access_denied" || got.ErrorDescription != "You cancelled." {
		t.Fatalf("result %+v", got)
	}

	b2, _ := s.Begin()
	go func() { time.Sleep(20 * time.Millisecond); s.Cancel(b2.ID) }()
	if got := s.Wait(b2.ID); got.Error != "cancelled" {
		t.Fatalf("cancel %+v", got)
	}
	// A new Begin cancels a flow still waiting.
	b3, _ := s.Begin()
	b4, _ := s.Begin()
	if got := s.Wait(b3.ID); got.Error != "cancelled" {
		t.Fatalf("superseded %+v", got)
	}
	s.Cancel(b4.ID)
}

func TestSSOLoopbackTimeout(t *testing.T) {
	s := NewSSOService()
	s.timeout = 30 * time.Millisecond
	b, _ := s.Begin()
	if got := s.Wait(b.ID); got.Error != "timeout" {
		t.Fatalf("timeout %+v", got)
	}
}
