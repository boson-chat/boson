package main

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

type fakePushPlatform struct {
	mu       sync.Mutex
	recs     map[string]*pushRecord
	token    string
	platform string
	attests  [][]byte
	prefs    []byte
	tokenErr error
	resets   int
	hasKey   bool
}

func (f *fakePushPlatform) Name() string      { return "ios" }
func (f *fakePushPlatform) Supported() string { return "" }
func (f *fakePushPlatform) Token(context.Context) (string, string, error) {
	return f.platform, f.token, f.tokenErr
}

// Like iOS: a new key's attestation object first, assertions after.
func (f *fakePushPlatform) Attest(_ context.Context, hash []byte) (pushAttestation, error) {
	f.attests = append(f.attests, hash)
	h := base64.StdEncoding.EncodeToString(hash)
	if !f.hasKey {
		f.hasKey = true
		return pushAttestation{KeyID: "key", AttestationObject: "obj:" + h}, nil
	}
	return pushAttestation{KeyID: "key", Attestation: "assert:" + h}, nil
}
func (f *fakePushPlatform) ResetAttestKey() { f.resets++; f.hasKey = false }
func (f *fakePushPlatform) Load(id string) (*pushRecord, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	r := f.recs[id]
	if r == nil {
		return nil, errors.New("none")
	}
	c := *r
	return &c, nil
}
func (f *fakePushPlatform) Save(r *pushRecord) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	c := *r
	f.recs[r.ServerID] = &c
	return nil
}
func (f *fakePushPlatform) Delete(id string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	delete(f.recs, id)
	return nil
}
func (f *fakePushPlatform) WritePrefs(p []byte) error { f.prefs = p; return nil }

// A relay per boson-chat/pushrelay's README: challenges, attestation bound
// to the client data, mailboxes with secrets.
type fakeRelay struct {
	srv        *httptest.Server
	mu         sync.Mutex
	created    []mailboxRequest
	patched    []string
	deleted    []string
	mailboxes  map[string]string // id → secret
	challenges map[string]bool
	keys       map[string]bool // registered App Attest keys
	n          int
}

func newFakeRelay(t *testing.T) *fakeRelay {
	r := &fakeRelay{mailboxes: map[string]string{}, challenges: map[string]bool{}, keys: map[string]bool{}}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /v1/challenge", func(w http.ResponseWriter, _ *http.Request) {
		r.mu.Lock()
		r.n++
		n := r.n
		r.mu.Unlock()
		c := "c" + string(rune('0'+n))
		r.challenges[c] = true
		json.NewEncoder(w).Encode(map[string]any{"challenge": c, "expires_at": "2026-11-27T14:05:53Z", "expires_in": 300})
	})
	mux.HandleFunc("POST /v1/mailboxes", func(w http.ResponseWriter, req *http.Request) {
		var m mailboxRequest
		if err := json.NewDecoder(req.Body).Decode(&m); err != nil {
			http.Error(w, "bad", http.StatusBadRequest)
			return
		}
		r.mu.Lock()
		defer r.mu.Unlock()
		fail := func(status int, code string) {
			w.WriteHeader(status)
			json.NewEncoder(w).Encode(map[string]string{"error": code, "message": code, "code": code})
		}
		if !r.challenges[m.Challenge] {
			fail(http.StatusUnauthorized, "challenge_invalid")
			return
		}
		delete(r.challenges, m.Challenge)
		sum := sha256.Sum256(pushClientData(m.Challenge, m.Platform, m.Token, m.VAPID, m.Install))
		h := base64.StdEncoding.EncodeToString(sum[:])
		switch {
		case m.AttestationObject != "":
			if m.AttestationObject != "obj:"+h {
				fail(http.StatusUnauthorized, "attestation_failed")
				return
			}
			r.keys[m.KeyID] = true
		case !r.keys[m.KeyID]:
			fail(http.StatusUnauthorized, "attest_key_unknown")
			return
		case m.Attestation != "assert:"+h:
			fail(http.StatusUnauthorized, "attestation_failed")
			return
		}
		r.created = append(r.created, m)
		id := "mb" + string(rune('0'+len(r.created)))
		r.mailboxes[id] = "secret-" + id
		w.WriteHeader(http.StatusCreated)
		json.NewEncoder(w).Encode(map[string]string{"id": id, "endpoint": r.srv.URL + "/v1/push/" + id, "secret": "secret-" + id})
	})
	auth := func(w http.ResponseWriter, req *http.Request) (string, bool) {
		id := req.PathValue("id")
		r.mu.Lock()
		sec, ok := r.mailboxes[id]
		r.mu.Unlock()
		if !ok {
			http.Error(w, `{"error":"no such mailbox"}`, http.StatusNotFound)
			return "", false
		}
		if req.Header.Get("Authorization") != "Bearer "+sec {
			http.Error(w, `{"error":"bad secret"}`, http.StatusUnauthorized)
			return "", false
		}
		return id, true
	}
	mux.HandleFunc("PATCH /v1/mailboxes/{id}", func(w http.ResponseWriter, req *http.Request) {
		id, ok := auth(w, req)
		if !ok {
			return
		}
		var b struct {
			Token *string `json:"token"`
		}
		json.NewDecoder(req.Body).Decode(&b)
		r.mu.Lock()
		if b.Token == nil {
			r.patched = append(r.patched, id+" renewed")
		} else {
			r.patched = append(r.patched, id+"="+*b.Token)
		}
		r.mu.Unlock()
		w.WriteHeader(http.StatusNoContent)
	})
	mux.HandleFunc("DELETE /v1/mailboxes/{id}", func(w http.ResponseWriter, req *http.Request) {
		id, ok := auth(w, req)
		if !ok {
			return
		}
		r.mu.Lock()
		r.deleted = append(r.deleted, id)
		delete(r.mailboxes, id)
		r.mu.Unlock()
		w.WriteHeader(http.StatusNoContent)
	})
	r.srv = httptest.NewServer(mux)
	t.Cleanup(r.srv.Close)
	return r
}

func newTestPush(t *testing.T, relay string) (*PushService, *fakePushPlatform) {
	t.Helper()
	disc := &voiceDiscoverer{allowHTTP: true, now: time.Now, overrideNets: map[string]*VoiceDiscovery{
		"irc.example.org": {Host: "irc.example.org", Push: relay},
		"irc.norelay.org": {Host: "irc.norelay.org"},
	}}
	plat := &fakePushPlatform{recs: map[string]*pushRecord{}, token: "tok1", platform: "apns-sandbox"}
	return NewPushService(plat, disc), plat
}

func TestPushSubscribeCreatesMailboxAndKeys(t *testing.T) {
	relay := newFakeRelay(t)
	s, plat := newTestPush(t, relay.srv.URL)
	sub, err := s.Subscribe("s1", "Example", "irc.example.org", "BVAPID")
	if err != nil {
		t.Fatal(err)
	}
	if sub.Endpoint != relay.srv.URL+"/v1/push/mb1" {
		t.Fatalf("endpoint %q", sub.Endpoint)
	}
	if len(relay.created) != 1 {
		t.Fatalf("created %d mailboxes", len(relay.created))
	}
	m := relay.created[0]
	want := sha256.Sum256([]byte("boson-push-v1\nc1\napns-sandbox\ntok1\nBVAPID\nexample.org"))
	if m.Platform != "apns-sandbox" || m.Token != "tok1" || m.App != "chat.boson.app" || m.VAPID != "BVAPID" ||
		m.Install != "example.org" || m.Challenge != "c1" || m.KeyID != "key" || m.Attestation != "" ||
		m.AttestationObject != "obj:"+base64.StdEncoding.EncodeToString(want[:]) {
		t.Fatalf("mailbox request %+v", m)
	}
	// A second server's mailbox asserts with the registered key.
	if _, err := s.Subscribe("s2", "Example", "irc.example.org", "BVAPID"); err != nil {
		t.Fatal(err)
	}
	if m2 := relay.created[1]; m2.AttestationObject != "" || !strings.HasPrefix(m2.Attestation, "assert:") {
		t.Fatalf("second request %+v", m2)
	}
	rec := plat.recs["s1"]
	if rec.Mailbox != "mb1" || rec.Secret != "secret-mb1" || rec.ServerName != "Example" {
		t.Fatalf("record %+v", rec)
	}
	priv, _ := b64.DecodeString(rec.Private)
	pub, _ := b64.DecodeString(sub.P256dh)
	auth, _ := b64.DecodeString(sub.Auth)
	if len(priv) != 32 || len(pub) != 65 || pub[0] != 4 || len(auth) != 16 {
		t.Fatalf("key sizes %d %d %d", len(priv), len(pub), len(auth))
	}
}

func TestPushSubscribeReusesAndRefreshesToken(t *testing.T) {
	relay := newFakeRelay(t)
	s, plat := newTestPush(t, relay.srv.URL)
	first, err := s.Subscribe("s1", "Example", "irc.example.org", "BVAPID")
	if err != nil {
		t.Fatal(err)
	}
	again, err := s.Subscribe("s1", "Renamed", "irc.example.org", "BVAPID")
	if err != nil {
		t.Fatal(err)
	}
	if *again != *first || len(relay.created) != 1 || plat.recs["s1"].ServerName != "Renamed" {
		t.Fatalf("not reused: %+v vs %+v, %d created", again, first, len(relay.created))
	}
	// The token rotated: PATCH, same mailbox.
	plat.token = "tok2"
	if _, err := s.Subscribe("s1", "Renamed", "irc.example.org", "BVAPID"); err != nil {
		t.Fatal(err)
	}
	if strings.Join(relay.patched, ",") != "mb1=tok2" || plat.recs["s1"].Token != "tok2" || len(relay.created) != 1 {
		t.Fatalf("patched %v, created %d", relay.patched, len(relay.created))
	}
	// A day later: renewed (an empty PATCH), so the relay keeps it.
	s.now = func() time.Time { return time.Now().Add(25 * time.Hour) }
	if _, err := s.Subscribe("s1", "Renamed", "irc.example.org", "BVAPID"); err != nil {
		t.Fatal(err)
	}
	if strings.Join(relay.patched, ",") != "mb1=tok2,mb1 renewed" {
		t.Fatalf("patched %v", relay.patched)
	}
}

func TestPushReattestsAKeyTheRelayForgot(t *testing.T) {
	relay := newFakeRelay(t)
	s, plat := newTestPush(t, relay.srv.URL)
	if _, err := s.Subscribe("s1", "Example", "irc.example.org", "BVAPID"); err != nil {
		t.Fatal(err)
	}
	relay.mu.Lock()
	relay.keys = map[string]bool{} // the relay's database was reset
	relay.mu.Unlock()
	if _, err := s.Subscribe("s2", "Example", "irc.example.org", "BVAPID"); err != nil {
		t.Fatal(err)
	}
	if plat.resets != 1 || len(relay.created) != 2 || relay.created[1].AttestationObject == "" {
		t.Fatalf("resets %d, created %+v", plat.resets, relay.created)
	}
}

func TestPushSubscribeNewVAPIDReplacesMailbox(t *testing.T) {
	relay := newFakeRelay(t)
	s, plat := newTestPush(t, relay.srv.URL)
	if _, err := s.Subscribe("s1", "Example", "irc.example.org", "BVAPID"); err != nil {
		t.Fatal(err)
	}
	sub, err := s.Subscribe("s1", "Example", "irc.example.org", "BOTHER")
	if err != nil {
		t.Fatal(err)
	}
	if len(relay.created) != 2 || strings.Join(relay.deleted, ",") != "mb1" || !strings.HasSuffix(sub.Endpoint, "/mb2") || plat.recs["s1"].VAPID != "BOTHER" {
		t.Fatalf("created %d deleted %v endpoint %s", len(relay.created), relay.deleted, sub.Endpoint)
	}
}

func TestPushSubscribeRecreatesAGoneMailbox(t *testing.T) {
	relay := newFakeRelay(t)
	s, plat := newTestPush(t, relay.srv.URL)
	if _, err := s.Subscribe("s1", "Example", "irc.example.org", "BVAPID"); err != nil {
		t.Fatal(err)
	}
	relay.mu.Lock()
	delete(relay.mailboxes, "mb1") // expired on the relay
	relay.mu.Unlock()
	plat.token = "tok2"
	sub, err := s.Subscribe("s1", "Example", "irc.example.org", "BVAPID")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasSuffix(sub.Endpoint, "/mb2") {
		t.Fatalf("endpoint %s", sub.Endpoint)
	}
}

func TestPushUnsubscribeDeletesMailboxAndKeys(t *testing.T) {
	relay := newFakeRelay(t)
	s, plat := newTestPush(t, relay.srv.URL)
	if _, err := s.Subscribe("s1", "Example", "irc.example.org", "BVAPID"); err != nil {
		t.Fatal(err)
	}
	s.Unsubscribe("s1")
	if strings.Join(relay.deleted, ",") != "mb1" || plat.recs["s1"] != nil {
		t.Fatalf("deleted %v, record %+v", relay.deleted, plat.recs["s1"])
	}
	// The relay unreachable: the keys still go.
	if _, err := s.Subscribe("s2", "Example", "irc.example.org", "BVAPID"); err != nil {
		t.Fatal(err)
	}
	relay.srv.Close()
	s.Unsubscribe("s2")
	if plat.recs["s2"] != nil {
		t.Fatal("keys kept after a failed delete")
	}
}

func TestPushSubscribeErrors(t *testing.T) {
	relay := newFakeRelay(t)
	s, plat := newTestPush(t, relay.srv.URL)
	if _, err := s.Subscribe("s1", "X", "irc.norelay.org", "BVAPID"); err == nil || !strings.HasPrefix(err.Error(), "no-relay:") {
		t.Fatalf("no relay: %v", err)
	}
	plat.tokenErr = pushErr("denied", "notifications are off")
	if _, err := s.Subscribe("s1", "X", "irc.example.org", "BVAPID"); err == nil || !strings.HasPrefix(err.Error(), "denied:") {
		t.Fatalf("denied: %v", err)
	}
	if NewPushService(nil, nil).Info().Platform != "" {
		t.Fatal("desktop has a platform")
	}
	if _, err := NewPushService(nil, nil).Subscribe("s", "S", "h", "v"); err == nil || !strings.HasPrefix(err.Error(), "unsupported:") {
		t.Fatalf("desktop: %v", err)
	}
}

func TestPushRelayRefusalAndForeignEndpoint(t *testing.T) {
	bad := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/v1/challenge":
			w.Write([]byte(`{"challenge":"x"}`))
		default:
			w.WriteHeader(http.StatusCreated)
			w.Write([]byte(`{"endpoint":"https://evil.example/v1/push/1","secret":"s"}`))
		}
	}))
	defer bad.Close()
	s, _ := newTestPush(t, bad.URL)
	if _, err := s.Subscribe("s1", "X", "irc.example.org", "BVAPID"); err == nil || !strings.Contains(err.Error(), "endpoint elsewhere") {
		t.Fatalf("foreign endpoint: %v", err)
	}
	refusing := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/v1/challenge" {
			w.Write([]byte(`{"challenge":"x"}`))
			return
		}
		w.WriteHeader(http.StatusUnauthorized)
		w.Write([]byte(`{"error":"attestation_failed","message":"attestation did not verify","code":"attestation_failed"}`))
	}))
	defer refusing.Close()
	s2, _ := newTestPush(t, refusing.URL)
	if _, err := s2.Subscribe("s1", "X", "irc.example.org", "BVAPID"); err == nil || err.Error() != "relay: the push relay refused: attestation did not verify" {
		t.Fatalf("refused: %v", err)
	}
}

func TestParseWellKnownPush(t *testing.T) {
	for doc, want := range map[string]string{
		`{"version":1,"push":{"version":1,"relay":"https://push.boson.chat"}}`: "https://push.boson.chat",
		`{"version":1,"push":{"relay":"https://push.example.org/"}}`:           "https://push.example.org",
		`{"version":1,"push":{"version":1,"relay":""}}`:                        "",
		`{"version":1,"push":{"version":1,"relay":"http://push.example.org"}}`: "",
		`{"version":1}`: "",
		`{"version":1,"push":{"version":2,"relay":"https://push.boson.chat"}}`: "",
	} {
		if got := parseWellKnownPush([]byte(doc), false); got != want {
			t.Errorf("%s: %q, want %q", doc, got, want)
		}
	}
}

func TestPushRelayForFetchesAndCaches(t *testing.T) {
	hits := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits++
		w.Write([]byte(`{"version":1,"push":{"version":1,"relay":"https://push.boson.chat"}}`))
	}))
	defer srv.Close()
	disc := &voiceDiscoverer{http: srv.Client(), wellKnownURL: func(string) string { return srv.URL }, now: time.Now}
	s := NewPushService(&fakePushPlatform{recs: map[string]*pushRecord{}}, disc)
	if got := s.RelayFor("irc.example.org"); got != "https://push.boson.chat" {
		t.Fatalf("relay %q", got)
	}
	s.RelayFor("irc.example.org")
	if hits != 1 {
		t.Fatalf("%d fetches", hits)
	}
}

func TestPushOpensQueueUntilListened(t *testing.T) {
	q := &pushOpenQueue{}
	q.deliver(PushOpen{ServerID: "s1", Conversation: "#team"})
	if o := q.take(); o == nil || o.Conversation != "#team" {
		t.Fatalf("pending %+v", o)
	}
	if q.take() != nil {
		t.Fatal("taken twice")
	}
	var got []PushOpen
	q.listen(func(o PushOpen) { got = append(got, o) })
	q.deliver(PushOpen{ServerID: "s1", Conversation: "alice"})
	if len(got) != 1 || q.take() != nil {
		t.Fatalf("live %v", got)
	}
}

func TestPushSyncPrefs(t *testing.T) {
	plat := &fakePushPlatform{recs: map[string]*pushRecord{}}
	s := NewPushService(plat, nil)
	if err := s.SyncPrefs(`{"v":1,"enabled":true}`); err != nil || string(plat.prefs) != `{"v":1,"enabled":true}` {
		t.Fatalf("%v %s", err, plat.prefs)
	}
	if err := s.SyncPrefs(`nope`); err == nil {
		t.Fatal("took non-JSON")
	}
}
