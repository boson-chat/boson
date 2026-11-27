package main

import (
	"bytes"
	"context"
	"crypto/ecdh"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/wailsapp/wails/v3/pkg/application"
)

// PushService: push notifications on the phones (docs/push.md §2, §3),
// behind the renderer's window.bosonPush (platform/wails.ts). For each
// server the person is signed in to it keeps a P-256 key pair and auth
// secret, and a mailbox on the push relay that server's boson.json names:
// the mailbox's URL is the Web Push endpoint the renderer registers with
// the server (WEBPUSH REGISTER). The server encrypts to the key (RFC 8291);
// the relay forwards the ciphertext through APNs / FCM; the app's
// Notification Service Extension (iOS, desktop/build/ios/push/) or FCM
// service (Android, BosonPushService.java) decrypts it with the stored key
// and shows it. The relay never sees a key.
//
// The platform part — the device token, attestation for the relay, where
// keys live so the receiver can read them — is pushPlatform
// (push_ios.go, push_android.go). Desktop builds have none: the renderer
// then says push comes later (phase 2).
type PushService struct {
	plat   pushPlatform
	disc   *voiceDiscoverer
	client *http.Client
	now    func() time.Time

	mu   sync.Mutex
	docs map[string]pushDocCache
	open *PushOpen
	app  *application.App
	// One subscribe/unsubscribe per server at a time.
	locks map[string]*sync.Mutex
}

type pushDocCache struct {
	relay string
	at    time.Time
}

const (
	pushAppID       = "chat.boson.app"
	pushDocTTL      = 10 * time.Minute
	pushOpenEvent   = "push:open"
	pushRelayMaxDoc = 64 << 10
)

// The platform's part.
type pushPlatform interface {
	// "ios" or "android".
	Name() string
	// Why push can't work on this device ("" when it can).
	Supported() string
	// The device's push token, and the relay platform it's for: "apns",
	// "apns-sandbox" (development builds) or "fcm". Registers with the
	// push service (and asks for notification permission) when needed.
	Token(ctx context.Context) (platform, token string, err error)
	// Proof for the relay that this is the official app on a real device,
	// over the relay's challenge.
	Attest(ctx context.Context, challenge string) (pushAttestation, error)
	// Per-server records, where the receiver reads them (the keychain
	// shared with the extension / the app's encrypted preferences).
	Load(serverID string) (*pushRecord, error)
	Save(rec *pushRecord) error
	Delete(serverID string) error
	// The notification settings (modules/push/filter.ts PushPrefs JSON).
	WritePrefs(prefs []byte) error
}

// What the relay is shown with a new mailbox (POST /v1/mailboxes).
//
//	Kind "app-attest"     iOS, the first mailbox on this install: Data is
//	                      the App Attest attestation object for KeyID.
//	     "app-assert"     iOS afterwards: an assertion with KeyID.
//	     "play-integrity" Android: Data is the Play Integrity token.
//	     "dev"            development builds (apns-sandbox, the relay's dev
//	                      allowlist): no proof.
type pushAttestation struct {
	Kind  string
	KeyID string
	Data  string
}

// One server's push state on this device. Private and Auth are secret.
type pushRecord struct {
	V          int    `json:"v"`
	ServerID   string `json:"serverId"`
	ServerName string `json:"serverName"`
	Relay      string `json:"relay"`
	Install    string `json:"install"`
	VAPID      string `json:"vapid"`
	Platform   string `json:"platform"`
	Token      string `json:"token"`
	Mailbox    string `json:"mailbox"`
	Endpoint   string `json:"endpoint"`
	Secret     string `json:"secret"`
	// base64url (no padding): the P-256 private scalar (32 bytes), public
	// point (65 bytes, uncompressed) and auth secret (16 bytes).
	Private string `json:"private"`
	Public  string `json:"public"`
	Auth    string `json:"auth"`
}

// PushInfo: what the renderer's bridge needs to know.
type PushInfo struct {
	Platform string `json:"platform"`
}

// PushSubscription is what WEBPUSH REGISTER takes.
type PushSubscription struct {
	Endpoint string `json:"endpoint"`
	P256dh   string `json:"p256dh"`
	Auth     string `json:"auth"`
}

// PushOpen: a push notification was tapped.
type PushOpen struct {
	ServerID     string `json:"serverId"`
	Conversation string `json:"conversation"`
}

// Errors carry a code the renderer turns into a PushError (push.types.ts):
// "<code>: <message>".
func pushErr(code, msg string) error { return fmt.Errorf("%s: %s", code, msg) }

var b64 = base64.RawURLEncoding

func NewPushService(plat pushPlatform, disc *voiceDiscoverer) *PushService {
	return &PushService{
		plat:   plat,
		disc:   disc,
		client: &http.Client{Timeout: 20 * time.Second},
		now:    time.Now,
		docs:   map[string]pushDocCache{},
		locks:  map[string]*sync.Mutex{},
	}
}

func (s *PushService) ServiceStartup(ctx context.Context, _ application.ServiceOptions) error {
	s.mu.Lock()
	s.app = application.Get()
	s.mu.Unlock()
	pushOpens.listen(s.opened)
	return nil
}

func (s *PushService) Info() PushInfo {
	if s.plat == nil {
		return PushInfo{}
	}
	return PushInfo{Platform: s.plat.Name()}
}

func (s *PushService) Supported() string {
	if s.plat == nil {
		return "Push isn’t available in this build."
	}
	return s.plat.Supported()
}

// RelayFor is the push relay host's boson.json recommends ("" none).
func (s *PushService) RelayFor(host string) string {
	ctx, cancel := context.WithTimeout(context.Background(), 2*voiceDiscoveryTimeout)
	defer cancel()
	return s.relayFor(ctx, host)
}

func (s *PushService) relayFor(ctx context.Context, rawHost string) string {
	if s.disc == nil {
		return ""
	}
	host := strings.ToLower(strings.TrimSpace(rawHost))
	if o := s.disc.overrideNets[host]; o != nil {
		return o.Push
	}
	domain := voiceDomain(host)
	if c := s.disc.cached(host); c != nil && c.Domain != "" {
		domain = c.Domain
	}
	if domain == "" {
		return ""
	}
	s.mu.Lock()
	hit, ok := s.docs[domain]
	s.mu.Unlock()
	if ok && s.now().Sub(hit.at) < pushDocTTL {
		return hit.relay
	}
	body, answered := s.disc.fetchWellKnownBody(ctx, domain)
	if !answered {
		return hit.relay
	}
	relay := parseWellKnownPush(body, s.disc.allowHTTP)
	s.mu.Lock()
	s.docs[domain] = pushDocCache{relay: relay, at: s.now()}
	s.mu.Unlock()
	return relay
}

// parseWellKnownPush reads a boson.json's push.relay ("" when absent,
// empty — the install turned phone push off — or invalid).
func parseWellKnownPush(body []byte, allowHTTP bool) string {
	var doc struct {
		Version int `json:"version"`
		Push    *struct {
			Version int    `json:"version"`
			Relay   string `json:"relay"`
		} `json:"push"`
	}
	if json.Unmarshal(body, &doc) != nil || doc.Version != 1 || doc.Push == nil {
		return ""
	}
	if doc.Push.Version != 0 && doc.Push.Version != 1 {
		return ""
	}
	base, err := cleanBaseURL(strings.TrimSpace(doc.Push.Relay), allowHTTP)
	if err != nil {
		return ""
	}
	return base
}

func (s *PushService) lock(serverID string) func() {
	s.mu.Lock()
	l := s.locks[serverID]
	if l == nil {
		l = &sync.Mutex{}
		s.locks[serverID] = l
	}
	s.mu.Unlock()
	l.Lock()
	return l.Unlock
}

// Subscribe makes (or reuses) the server's mailbox and keys.
func (s *PushService) Subscribe(serverID, serverName, host, vapid string) (*PushSubscription, error) {
	if s.plat == nil {
		return nil, pushErr("unsupported", "no push in this build")
	}
	if serverID == "" || vapid == "" {
		return nil, pushErr("failed", "missing server or VAPID key")
	}
	defer s.lock(serverID)()
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	relay := s.relayFor(ctx, host)
	if relay == "" {
		return nil, pushErr("no-relay", "the server names no push relay")
	}
	platform, token, err := s.plat.Token(ctx)
	if err != nil {
		return nil, err
	}
	install := voiceDomain(host)
	if install == "" {
		install = strings.ToLower(host)
	}
	rec, _ := s.plat.Load(serverID)
	if rec != nil && rec.Relay == relay && rec.VAPID == vapid && rec.Platform == platform && rec.Endpoint != "" {
		if rec.Token != token {
			switch err := s.patchMailbox(ctx, rec, token); {
			case err == nil:
				rec.Token = token
			case errors.Is(err, errMailboxGone):
				rec = nil
			default:
				return nil, err
			}
		}
		if rec != nil {
			rec.ServerName = serverName
			if err := s.plat.Save(rec); err != nil {
				return nil, pushErr("failed", err.Error())
			}
			return &PushSubscription{Endpoint: rec.Endpoint, P256dh: rec.Public, Auth: rec.Auth}, nil
		}
	} else if rec != nil {
		// Another relay or VAPID key (the server's changed): a new mailbox.
		_ = s.deleteMailbox(ctx, rec)
	}

	priv, err := ecdh.P256().GenerateKey(rand.Reader)
	if err != nil {
		return nil, pushErr("failed", err.Error())
	}
	auth := make([]byte, 16)
	if _, err := rand.Read(auth); err != nil {
		return nil, pushErr("failed", err.Error())
	}
	challenge, err := s.challenge(ctx, relay)
	if err != nil {
		return nil, err
	}
	att, err := s.plat.Attest(ctx, challenge)
	if err != nil {
		return nil, err
	}
	mb, err := s.createMailbox(ctx, relay, mailboxRequest{
		Platform:        platform,
		Token:           token,
		App:             pushAppID,
		Attestation:     att.Data,
		AttestationType: att.Kind,
		KeyID:           att.KeyID,
		Challenge:       challenge,
		VAPID:           vapid,
		Install:         install,
	})
	if err != nil {
		return nil, err
	}
	rec = &pushRecord{
		V: 1, ServerID: serverID, ServerName: serverName, Relay: relay, Install: install, VAPID: vapid,
		Platform: platform, Token: token, Mailbox: mb.ID, Endpoint: mb.Endpoint, Secret: mb.Secret,
		Private: b64.EncodeToString(priv.Bytes()), Public: b64.EncodeToString(priv.PublicKey().Bytes()), Auth: b64.EncodeToString(auth),
	}
	if err := s.plat.Save(rec); err != nil {
		_ = s.deleteMailbox(ctx, rec)
		return nil, pushErr("failed", err.Error())
	}
	return &PushSubscription{Endpoint: rec.Endpoint, P256dh: rec.Public, Auth: rec.Auth}, nil
}

// Unsubscribe deletes the server's mailbox (best-effort: an unreachable
// relay still loses the keys, so nothing can be shown) and its keys.
func (s *PushService) Unsubscribe(serverID string) {
	if s.plat == nil {
		return
	}
	defer s.lock(serverID)()
	rec, _ := s.plat.Load(serverID)
	if rec != nil {
		ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		if err := s.deleteMailbox(ctx, rec); err != nil {
			log.Printf("push: deleting the mailbox for %s: %v", serverID, err)
		}
		cancel()
	}
	_ = s.plat.Delete(serverID)
}

// SyncPrefs stores the notification settings where the receiver reads them.
func (s *PushService) SyncPrefs(prefs string) error {
	if s.plat == nil {
		return nil
	}
	if !json.Valid([]byte(prefs)) {
		return errors.New("push: prefs aren't JSON")
	}
	return s.plat.WritePrefs([]byte(prefs))
}

// ConsumeOpen is a tap that started the app, once.
func (s *PushService) ConsumeOpen() *PushOpen {
	return pushOpens.take()
}

func (s *PushService) opened(o PushOpen) {
	s.mu.Lock()
	app := s.app
	s.mu.Unlock()
	if app != nil {
		app.Event.Emit(pushOpenEvent, o)
	}
}

// ---- taps, from the platform (before or after the app is up) ----

type pushOpenQueue struct {
	mu      sync.Mutex
	pending *PushOpen
	fn      func(PushOpen)
}

var pushOpens = &pushOpenQueue{}

// deliver: a tap. Held for ConsumeOpen until the service listens.
func (q *pushOpenQueue) deliver(o PushOpen) {
	q.mu.Lock()
	fn := q.fn
	if fn == nil {
		q.pending = &o
	}
	q.mu.Unlock()
	if fn != nil {
		fn(o)
	}
}

func (q *pushOpenQueue) listen(fn func(PushOpen)) {
	q.mu.Lock()
	q.fn = fn
	q.mu.Unlock()
}

func (q *pushOpenQueue) take() *PushOpen {
	q.mu.Lock()
	defer q.mu.Unlock()
	o := q.pending
	q.pending = nil
	return o
}

// ---- the relay (docs/push.md §2.1, §2.3) ----

var errMailboxGone = errors.New("push: the relay has no such mailbox")

type mailboxRequest struct {
	Platform        string `json:"platform"`
	Token           string `json:"token"`
	App             string `json:"app"`
	Attestation     string `json:"attestation"`
	AttestationType string `json:"attestationType"`
	KeyID           string `json:"keyId,omitempty"`
	Challenge       string `json:"challenge"`
	VAPID           string `json:"vapid"`
	Install         string `json:"install"`
}

type mailboxResponse struct {
	ID       string `json:"id"`
	Endpoint string `json:"endpoint"`
	Secret   string `json:"secret"`
}

func (s *PushService) relayURL(relay, path string) string {
	return strings.TrimRight(relay, "/") + path
}

func (s *PushService) do(ctx context.Context, method, u, secret string, body any) (*http.Response, []byte, error) {
	var rd io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			return nil, nil, err
		}
		rd = bytes.NewReader(b)
	}
	req, err := http.NewRequestWithContext(ctx, method, u, rd)
	if err != nil {
		return nil, nil, err
	}
	req.Header.Set("Accept", "application/json")
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if secret != "" {
		req.Header.Set("Authorization", "Bearer "+secret)
	}
	resp, err := s.client.Do(req)
	if err != nil {
		return nil, nil, err
	}
	defer resp.Body.Close()
	b, err := io.ReadAll(io.LimitReader(resp.Body, pushRelayMaxDoc))
	return resp, b, err
}

func relayErr(resp *http.Response, body []byte) error {
	var e struct {
		Error   string `json:"error"`
		Message string `json:"message"`
	}
	_ = json.Unmarshal(body, &e)
	msg := e.Message
	if msg == "" {
		msg = e.Error
	}
	if msg == "" {
		msg = resp.Status
	}
	return pushErr("relay", "the push relay refused: "+msg)
}

// challenge: GET /v1/challenge → {"challenge": "…"}, single use, for the
// attestation.
func (s *PushService) challenge(ctx context.Context, relay string) (string, error) {
	resp, body, err := s.do(ctx, http.MethodGet, s.relayURL(relay, "/v1/challenge"), "", nil)
	if err != nil {
		return "", pushErr("relay", "the push relay can’t be reached")
	}
	if resp.StatusCode != http.StatusOK {
		return "", relayErr(resp, body)
	}
	var c struct {
		Challenge string `json:"challenge"`
	}
	if json.Unmarshal(body, &c) != nil || c.Challenge == "" {
		return "", pushErr("relay", "the push relay sent no challenge")
	}
	return c.Challenge, nil
}

func (s *PushService) createMailbox(ctx context.Context, relay string, req mailboxRequest) (*mailboxResponse, error) {
	resp, body, err := s.do(ctx, http.MethodPost, s.relayURL(relay, "/v1/mailboxes"), "", req)
	if err != nil {
		return nil, pushErr("relay", "the push relay can’t be reached")
	}
	if resp.StatusCode != http.StatusOK && resp.StatusCode != http.StatusCreated {
		return nil, relayErr(resp, body)
	}
	var mb mailboxResponse
	if json.Unmarshal(body, &mb) != nil || mb.Endpoint == "" || mb.Secret == "" {
		return nil, pushErr("relay", "the push relay’s answer is incomplete")
	}
	// The endpoint must be the relay's own (https; it's what the server
	// will POST to), and the id is its last segment unless given.
	eu, err := url.Parse(mb.Endpoint)
	ru, _ := url.Parse(relay)
	if err != nil || ru == nil || eu.Host != ru.Host || (eu.Scheme != "https" && !(s.disc != nil && s.disc.allowHTTP)) {
		return nil, pushErr("relay", "the push relay gave an endpoint elsewhere")
	}
	if mb.ID == "" {
		mb.ID = eu.Path[strings.LastIndex(eu.Path, "/")+1:]
	}
	return &mb, nil
}

// patchMailbox: a new device token (tokens rotate).
func (s *PushService) patchMailbox(ctx context.Context, rec *pushRecord, token string) error {
	resp, body, err := s.do(ctx, http.MethodPatch, s.relayURL(rec.Relay, "/v1/mailboxes/"+url.PathEscape(rec.Mailbox)), rec.Secret, map[string]string{"token": token})
	if err != nil {
		return pushErr("relay", "the push relay can’t be reached")
	}
	switch {
	case resp.StatusCode == http.StatusNotFound || resp.StatusCode == http.StatusGone:
		return errMailboxGone
	case resp.StatusCode >= 300:
		return relayErr(resp, body)
	}
	return nil
}

func (s *PushService) deleteMailbox(ctx context.Context, rec *pushRecord) error {
	if rec.Relay == "" || rec.Mailbox == "" {
		return nil
	}
	resp, body, err := s.do(ctx, http.MethodDelete, s.relayURL(rec.Relay, "/v1/mailboxes/"+url.PathEscape(rec.Mailbox)), rec.Secret, nil)
	if err != nil {
		return err
	}
	if resp.StatusCode >= 300 && resp.StatusCode != http.StatusNotFound && resp.StatusCode != http.StatusGone {
		return relayErr(resp, body)
	}
	return nil
}
