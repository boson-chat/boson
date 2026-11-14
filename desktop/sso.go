package main

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/base64"
	"html"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"sync"
	"time"
)

// SSOService is the desktop half of "Sign in with …" (RFC 8252 style): a
// one-shot loopback HTTP listener on 127.0.0.1:<random port> that the
// system browser comes back to after the identity provider, carrying the
// auth service's one-time code. The renderer makes the PKCE pair, opens the
// browser at the provider's start_url with return_to = RedirectURI, Waits
// for the code here and trades it at POST /v1/sso/exchange with its
// verifier, so the code alone is useless to anyone else who catches it.
//
// The redirect also carries a random `s` parameter (the auth service keeps
// return_to's query), and only a callback with that value is accepted: a
// page that guesses the port can't feed the app a code of its own.
type SSOService struct {
	// listen opens the loopback listener (tests swap it).
	listen  func() (net.Listener, error)
	timeout time.Duration

	mu    sync.Mutex
	flows map[string]*ssoFlow
}

// SSOBegin is a started flow: give RedirectURI to the auth service as
// return_to, then Wait(ID).
type SSOBegin struct {
	ID          string `json:"id"`
	RedirectURI string `json:"redirectUri"`
}

// SSOResult is how a flow ended: Code (bsc_…) on success, else Error (the
// auth service's error code, or cancelled / timeout) with a description.
type SSOResult struct {
	Code             string `json:"code,omitempty"`
	Error            string `json:"error,omitempty"`
	ErrorDescription string `json:"errorDescription,omitempty"`
}

type ssoFlow struct {
	srv   *http.Server
	state string
	done  chan SSOResult
	once  sync.Once
}

const ssoFlowTimeout = 10 * time.Minute

func NewSSOService() *SSOService {
	return &SSOService{
		listen:  func() (net.Listener, error) { return net.Listen("tcp", "127.0.0.1:0") },
		timeout: ssoFlowTimeout,
		flows:   map[string]*ssoFlow{},
	}
}

func ssoRandom(n int) string {
	b := make([]byte, n)
	_, _ = rand.Read(b)
	return base64.RawURLEncoding.EncodeToString(b)
}

// Begin starts a loopback listener for one sign-in. Any earlier flow that's
// still waiting is cancelled: one sign-in at a time.
func (s *SSOService) Begin() (SSOBegin, error) {
	s.cancelAll()
	ln, err := s.listen()
	if err != nil {
		return SSOBegin{}, err
	}
	f := &ssoFlow{state: ssoRandom(24), done: make(chan SSOResult, 1)}
	id := ssoRandom(12)
	mux := http.NewServeMux()
	mux.HandleFunc("/callback", func(w http.ResponseWriter, r *http.Request) { s.callback(id, f, w, r) })
	f.srv = &http.Server{Handler: mux, ReadHeaderTimeout: 10 * time.Second}
	go func() { _ = f.srv.Serve(ln) }()

	s.mu.Lock()
	s.flows[id] = f
	s.mu.Unlock()
	time.AfterFunc(s.timeout, func() {
		s.finish(id, SSOResult{Error: "timeout", ErrorDescription: "Sign-in took too long. Try again."})
	})

	port := ln.Addr().(*net.TCPAddr).Port
	redirect := (&url.URL{
		Scheme:   "http",
		Host:     net.JoinHostPort("127.0.0.1", strconv.Itoa(port)),
		Path:     "/callback",
		RawQuery: url.Values{"s": {f.state}}.Encode(),
	}).String()
	return SSOBegin{ID: id, RedirectURI: redirect}, nil
}

func (s *SSOService) callback(id string, f *ssoFlow, w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	if r.Method != http.MethodGet || subtle.ConstantTimeCompare([]byte(q.Get("s")), []byte(f.state)) != 1 {
		http.Error(w, "Not found", http.StatusNotFound)
		return
	}
	var res SSOResult
	switch {
	case q.Get("code") != "":
		res.Code = q.Get("code")
	case q.Get("error") != "":
		res.Error, res.ErrorDescription = q.Get("error"), q.Get("error_description")
	default:
		res.Error, res.ErrorDescription = "invalid_response", "The sign-in service sent no code."
	}
	ssoPage(w, res)
	// Answer the browser first, then shut the listener down.
	go s.finish(id, res)
}

// ssoPage is what the browser tab shows once it's handed the result back.
func ssoPage(w http.ResponseWriter, res SSOResult) {
	title, body := "You're signed in", "You can close this tab and go back to Boson."
	if res.Error != "" {
		title = "Sign-in didn't finish"
		body = "Go back to Boson to try again."
		if res.ErrorDescription != "" {
			body = res.ErrorDescription + " " + body
		}
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'")
	w.Header().Set("Referrer-Policy", "no-referrer")
	_, _ = w.Write([]byte(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Boson</title>
<style>
:root{color-scheme:dark light;--bg:#070709;--fg:#E2E2EA;--fg2:#9898A8;--accent:#D97706}
@media (prefers-color-scheme:light){:root{--bg:#f6f7f9;--fg:#15171c;--fg2:#5b6170}}
body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--fg);font:15px/1.5 'JetBrains Mono',ui-monospace,SFMono-Regular,Menlo,monospace}
main{max-width:28rem;padding:2rem 1.5rem}
h1{font-size:1.25rem;margin:0 0 .5rem}
p{margin:0;color:var(--fg2)}
.mark{display:inline-block;width:.6rem;height:.6rem;border-radius:50%;background:var(--accent);margin-right:.5rem;vertical-align:middle}
</style></head><body><main><h1><span class="mark"></span>` + html.EscapeString(title) + `</h1><p>` + html.EscapeString(body) + `</p></main></body></html>`))
}

// Wait blocks until the flow ends (the browser came back, it timed out, or
// it was cancelled).
func (s *SSOService) Wait(id string) SSOResult {
	s.mu.Lock()
	f := s.flows[id]
	s.mu.Unlock()
	if f == nil {
		return SSOResult{Error: "cancelled", ErrorDescription: "This sign-in isn't running any more."}
	}
	res := <-f.done
	f.done <- res // for any other waiter
	return res
}

// Cancel ends a waiting flow (the user pressed Cancel).
func (s *SSOService) Cancel(id string) {
	s.finish(id, SSOResult{Error: "cancelled", ErrorDescription: "Sign-in cancelled."})
}

func (s *SSOService) cancelAll() {
	s.mu.Lock()
	ids := make([]string, 0, len(s.flows))
	for id := range s.flows {
		ids = append(ids, id)
	}
	s.mu.Unlock()
	for _, id := range ids {
		s.Cancel(id)
	}
}

func (s *SSOService) finish(id string, res SSOResult) {
	s.mu.Lock()
	f := s.flows[id]
	s.mu.Unlock()
	if f == nil {
		return
	}
	f.once.Do(func() {
		f.done <- res
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		_ = f.srv.Shutdown(ctx)
		// Keep the entry briefly so a Wait that starts late still sees it.
		time.AfterFunc(time.Minute, func() {
			s.mu.Lock()
			delete(s.flows, id)
			s.mu.Unlock()
		})
	})
}

// ServiceShutdown stops any listener still waiting.
func (s *SSOService) ServiceShutdown() error {
	s.cancelAll()
	return nil
}
