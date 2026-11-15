//go:build !ios && !android

package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/wailsapp/wails/v3/pkg/application"
)

// FilesService: uploads to a network's files host (boson-chat/files) and the
// inline previews of what's on it.
//
// Where a network's files live: its /.well-known/boson.json `files.url`,
// else its auth service's /v1/config `files_url`. Both are looked up here,
// not in the renderer, so the shell decides which hosts it will talk to:
// only files hosts found that way are reachable (the allowlist), each its own
// origin (never the app's API, auth or directory).
//
// Why the shell does the upload: the page's CSP and CORS can't name every
// network's files host, and a Wails binding carries JSON, so a file sent
// through one would be base64 in renderer memory (a 100 MB video → 133 MB
// of string). Instead the renderer registers an upload (BeginUpload: the
// host, credentials, name, type and size) and POSTs the file in ArrayBuffer
// chunks to the app's own origin (/_boson/files/upload/<id>?offset=<n>,
// served by the asset handler; see serveUpload for why not the File
// itself). This handler pipes the chunks on to the files host as one
// request with the declared Content-Length, emitting files:progress events,
// and hands the files host's answer back as the last chunk's response.
// CancelUpload stops it.
//
// Previews: /_boson/files/view?u=<file URL> proxies GET/HEAD (Range too) of
// /f/<id>/<name> on an allowed files host, so images are fetched into blob:
// URLs and players stream from the app's own origin — the CSP stays as it
// is. The files host's own sandbox CSP and nosniff are kept on the answer.
type FilesService struct {
	disc   *voiceDiscoverer
	api    *ApiService
	dev    bool
	client *http.Client // short requests: config, usage, guest tokens
	stream *http.Client // uploads and previews: no overall timeout
	emit   func(name string, data any)
	now    func() time.Time

	mu      sync.Mutex
	hosts   map[string]string // origin → files base URL (the allowlist)
	docs    map[string]filesDocCache
	authCfg map[string]filesAuthCache
	pending map[string]*filesUpload
	active  map[string]*filesStream
}

type filesDocCache struct {
	body []byte
	at   time.Time
}

type filesAuthCache struct {
	url string
	at  time.Time
}

type filesUpload struct {
	base, auth, name, ctype string
	size                    int64
	at                      time.Time
}

const (
	FilesProgressEvent  = "files:progress"
	filesDocTTL         = 10 * time.Minute
	filesShortTimeout   = 10 * time.Second
	filesPendingTTL     = 2 * time.Minute
	filesMaxNameBytes   = 200
	filesMaxAnswerBytes = 64 << 10
	filesMaxHosts       = 64
	filesProgressEvery  = 100 * time.Millisecond
)

// FilesProgress is a files:progress event: Sent of Total bytes so far.
type FilesProgress struct {
	ID    string `json:"id"`
	Sent  int64  `json:"sent"`
	Total int64  `json:"total"`
}

func init() {
	application.RegisterEvent[FilesProgress](FilesProgressEvent)
}

func NewFilesService(disc *voiceDiscoverer, api *ApiService, dev bool) *FilesService {
	s := &FilesService{
		disc: disc, api: api, dev: dev, now: time.Now,
		hosts: map[string]string{}, docs: map[string]filesDocCache{}, authCfg: map[string]filesAuthCache{},
		pending: map[string]*filesUpload{}, active: map[string]*filesStream{},
	}
	transport := s.transport()
	noRedirect := func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	s.client = &http.Client{Timeout: filesShortTimeout, Transport: transport, CheckRedirect: noRedirect}
	s.stream = &http.Client{Transport: transport, CheckRedirect: noRedirect}
	return s
}

// transport refuses private addresses on every connection (a public name
// resolving to the LAN too); dev builds may reach loopback and the e2e
// host map.
func (s *FilesService) transport() *http.Transport {
	hostMap := map[string]string{}
	if s.dev {
		for _, kv := range strings.Split(os.Getenv("BOSON_E2E_HOST_MAP"), ",") {
			name, ip, ok := strings.Cut(strings.TrimSpace(kv), "=")
			if ok && name != "" && ip != "" {
				hostMap[strings.ToLower(name)] = ip
			}
		}
	}
	dialer := &net.Dialer{Timeout: filesShortTimeout}
	t := http.DefaultTransport.(*http.Transport).Clone()
	t.Proxy = nil
	t.ResponseHeaderTimeout = 2 * time.Minute
	t.DialContext = func(ctx context.Context, network, addr string) (net.Conn, error) {
		host, port, err := net.SplitHostPort(addr)
		if err != nil {
			return nil, err
		}
		if ip, ok := hostMap[strings.ToLower(host)]; ok {
			return dialer.DialContext(ctx, network, net.JoinHostPort(ip, port))
		}
		d := *dialer
		d.Control = func(_, address string, _ syscall.RawConn) error {
			h, _, err := net.SplitHostPort(address)
			if err != nil {
				return err
			}
			ip := net.ParseIP(h)
			if ip == nil {
				return errBlockedAddr
			}
			if s.dev && ip.IsLoopback() {
				return nil
			}
			if isBlockedIP(ip) {
				return errBlockedAddr
			}
			return nil
		}
		return d.DialContext(ctx, network, addr)
	}
	return t
}

func (s *FilesService) send(name string, data any) {
	if s.emit != nil {
		s.emit(name, data)
		return
	}
	if app := application.Get(); app != nil {
		app.Event.Emit(name, data)
	}
}

// ---- discovery ----

// FilesInfo is Discover's answer: the network's files host (FilesURL ""
// when it has none) and where that came from ("well-known" or "auth"), or
// Home's ("home"; Host is the app's auth service).
type FilesInfo struct {
	Host     string `json:"host"`
	FilesURL string `json:"filesUrl,omitempty"`
	Source   string `json:"source,omitempty"`
	Error    string `json:"error,omitempty"`
}

// Discover finds host's network files host and allows it.
func (s *FilesService) Discover(host string, refresh bool) FilesInfo {
	host = strings.ToLower(strings.TrimSpace(host))
	out := FilesInfo{Host: host}
	if host == "" {
		return out
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*voiceDiscoveryTimeout+filesShortTimeout)
	defer cancel()
	raw, auth := s.lookup(ctx, host, refresh)
	if raw != "" {
		out.Source = "well-known"
	} else if auth != "" {
		raw = s.authFilesURL(ctx, auth, refresh)
		if raw != "" {
			out.Source = "auth"
		}
	}
	if raw == "" {
		return out
	}
	base, err := s.trust(raw)
	if err != nil {
		out.Source, out.Error = "", err.Error()
		return out
	}
	out.FilesURL = base
	return out
}

// Home finds the files host of the app's own auth service (boson.chat's,
// or the configured default server's: its /v1/config files_url) and allows
// it. Uploads fall back to it, as the app's account, on a network without
// a files host of its own; its links render inline on any network.
func (s *FilesService) Home(refresh bool) FilesInfo {
	var out FilesInfo
	if s.api == nil {
		return out
	}
	auth := s.api.mainAuthOrigin()
	if auth == "" {
		return out
	}
	out.Host = auth
	ctx, cancel := context.WithTimeout(context.Background(), filesShortTimeout)
	defer cancel()
	raw := s.authFilesURL(ctx, auth, refresh)
	if raw == "" {
		return out
	}
	base, err := s.trust(raw)
	if err != nil {
		out.Error = err.Error()
		return out
	}
	out.FilesURL, out.Source = base, "home"
	return out
}

// lookup: the network's boson.json files.url and auth.url. Dev overrides
// (BOSON_NETWORK_JSON) first; else the document at the domain discovery
// uses for host, fetched here (cached a few minutes) so an older
// discovery cache without files doesn't hide them.
func (s *FilesService) lookup(ctx context.Context, host string, refresh bool) (files, auth string) {
	if s.disc == nil {
		return "", ""
	}
	if o := s.disc.overrideNets[host]; o != nil {
		return o.Files, o.Auth
	}
	domain := voiceDomain(host)
	if c := s.disc.cached(host); c != nil && c.Domain != "" {
		domain = c.Domain
	}
	if domain == "" {
		return "", ""
	}
	s.mu.Lock()
	hit, ok := s.docs[domain]
	s.mu.Unlock()
	var body []byte
	if ok && !refresh && s.now().Sub(hit.at) < filesDocTTL {
		body = hit.body
	} else {
		var answered bool
		body, answered = s.disc.fetchWellKnownBody(ctx, domain)
		if answered {
			s.mu.Lock()
			s.docs[domain] = filesDocCache{body: body, at: s.now()}
			s.mu.Unlock()
		} else if ok {
			body = hit.body
		}
	}
	if body == nil {
		return "", ""
	}
	auth, _ = parseWellKnownNetwork(body, s.disc.allowHTTP)
	return parseWellKnownFiles(body, s.disc.allowHTTP), auth
}

// authFilesURL is the auth service's /v1/config files_url ("" when it has
// none). The auth service is validated like sign-in's first.
func (s *FilesService) authFilesURL(ctx context.Context, auth string, refresh bool) string {
	if s.api == nil {
		return ""
	}
	base, _, err := s.api.TrustNetworkAuth(auth)
	if err != nil {
		return ""
	}
	s.mu.Lock()
	hit, ok := s.authCfg[base]
	s.mu.Unlock()
	if ok && !refresh && s.now().Sub(hit.at) < filesDocTTL {
		return hit.url
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, base+"/v1/config", nil)
	if err != nil {
		return ""
	}
	req.Header.Set("Accept", "application/json")
	res, err := s.client.Do(req)
	if err != nil {
		if ok {
			return hit.url
		}
		return ""
	}
	defer res.Body.Close()
	var cfg struct {
		FilesURL string `json:"files_url"`
	}
	if res.StatusCode == http.StatusOK {
		_ = json.NewDecoder(io.LimitReader(res.Body, filesMaxAnswerBytes)).Decode(&cfg)
	}
	s.mu.Lock()
	s.authCfg[base] = filesAuthCache{url: cfg.FilesURL, at: s.now()}
	s.mu.Unlock()
	return cfg.FilesURL
}

// parseWellKnownFiles reads a boson.json's files.url ("" when absent or
// invalid).
func parseWellKnownFiles(body []byte, allowHTTP bool) string {
	var doc struct {
		Version int `json:"version"`
		Files   *struct {
			URL string `json:"url"`
		} `json:"files"`
	}
	if json.Unmarshal(body, &doc) != nil || doc.Version != 1 || doc.Files == nil {
		return ""
	}
	base, err := cleanBaseURL(strings.TrimSpace(doc.Files.URL), allowHTTP)
	if err != nil {
		return ""
	}
	return base
}

// trust validates a files host and adds it to the allowlist: an https
// base URL (http on loopback in dev builds), no private address, and its
// own origin — not the app's API, auth service or directory, nor a
// network's auth service.
func (s *FilesService) trust(raw string) (string, error) {
	base, err := cleanBaseURL(raw, s.dev)
	if err != nil {
		return "", err
	}
	u, _ := url.Parse(base)
	if u.Scheme == "http" && !isLoopback(u) {
		return "", errors.New("files host is not https")
	}
	if !(s.dev && isLoopback(u)) && isBlockedHost(u.Hostname()) {
		return "", errBlockedAddr
	}
	o := origin(u)
	if s.api != nil && (s.api.policy.origins[o] || o == s.api.mainAuthOrigin() || s.api.nets.has(o)) {
		return "", errors.New("files host shares an origin with an app service")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, ok := s.hosts[o]; !ok && len(s.hosts) >= filesMaxHosts {
		return "", errors.New("too many files hosts")
	}
	s.hosts[o] = base
	return base, nil
}

// trustedBase: raw (a base URL or a file URL) is on an allowed files host;
// returns that host's base.
func (s *FilesService) trustedBase(raw string) (string, *url.URL, bool) {
	u, err := url.Parse(raw)
	if err != nil || u.Host == "" || u.User != nil || (u.Scheme != "https" && u.Scheme != "http") {
		return "", nil, false
	}
	s.mu.Lock()
	base, ok := s.hosts[origin(u)]
	s.mu.Unlock()
	return base, u, ok
}

// ---- API calls ----

// FilesRequest is one of the files host's small JSON calls.
type FilesRequest struct {
	FilesURL string `json:"filesUrl"`
	Method   string `json:"method"`
	Path     string `json:"path"`
	// Auth is the Authorization value: "Bearer <token>", "Guest <token>"
	// or "".
	Auth string `json:"auth,omitempty"`
}

type FilesResponse struct {
	Status int    `json:"status"`
	Body   string `json:"body,omitempty"`
	Error  string `json:"error,omitempty"`
}

// filesCalls are the only calls Request makes.
var filesCalls = map[string]bool{
	"GET /v1/config":       true,
	"GET /v1/me/usage":     true,
	"POST /v1/guest-token": true,
}

func cleanFilesAuth(auth string) (string, bool) {
	auth = strings.TrimSpace(auth)
	if auth == "" {
		return "", true
	}
	scheme, tok, ok := strings.Cut(auth, " ")
	if !ok || (scheme != "Bearer" && scheme != "Guest") || tok == "" || len(tok) > 8192 || strings.ContainsAny(tok, " \r\n\t") {
		return "", false
	}
	return auth, true
}

func (s *FilesService) Request(r FilesRequest) FilesResponse {
	base, _, ok := s.trustedBase(r.FilesURL)
	if !ok {
		return FilesResponse{Error: "not a files host"}
	}
	method := strings.ToUpper(r.Method)
	if !filesCalls[method+" "+r.Path] {
		return FilesResponse{Error: "not a files call"}
	}
	auth, ok := cleanFilesAuth(r.Auth)
	if !ok {
		return FilesResponse{Error: "bad credentials"}
	}
	ctx, cancel := context.WithTimeout(context.Background(), filesShortTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, method, base+r.Path, nil)
	if err != nil {
		return FilesResponse{Error: err.Error()}
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", "Boson")
	if auth != "" {
		req.Header.Set("Authorization", auth)
	}
	res, err := s.client.Do(req)
	if err != nil {
		return FilesResponse{Error: err.Error()}
	}
	defer res.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(res.Body, filesMaxAnswerBytes))
	return FilesResponse{Status: res.StatusCode, Body: string(body)}
}

// ---- uploads ----

type FilesUploadRequest struct {
	FilesURL string `json:"filesUrl"`
	Auth     string `json:"auth,omitempty"`
	Name     string `json:"name"`
	Type     string `json:"type,omitempty"`
	Size     int64  `json:"size"`
}

// FilesUploadTicket: POST the file's bytes to Path (the app's own origin).
type FilesUploadTicket struct {
	ID    string `json:"id,omitempty"`
	Path  string `json:"path,omitempty"`
	Error string `json:"error,omitempty"`
}

// BeginUpload registers an upload; the renderer then POSTs the file to the
// ticket's path. Unused tickets lapse after two minutes.
func (s *FilesService) BeginUpload(r FilesUploadRequest) FilesUploadTicket {
	base, _, ok := s.trustedBase(r.FilesURL)
	if !ok {
		return FilesUploadTicket{Error: "not a files host"}
	}
	auth, ok := cleanFilesAuth(r.Auth)
	if !ok {
		return FilesUploadTicket{Error: "bad credentials"}
	}
	if r.Size <= 0 {
		return FilesUploadTicket{Error: "empty file"}
	}
	name := cleanUploadName(r.Name)
	ctype := strings.TrimSpace(r.Type)
	if ctype == "" || len(ctype) > 255 || strings.ContainsAny(ctype, "\r\n") {
		ctype = "application/octet-stream"
	}
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		return FilesUploadTicket{Error: err.Error()}
	}
	id := hex.EncodeToString(b[:])
	s.mu.Lock()
	for k, p := range s.pending {
		if s.now().Sub(p.at) > filesPendingTTL {
			delete(s.pending, k)
		}
	}
	s.pending[id] = &filesUpload{base: base, auth: auth, name: name, ctype: ctype, size: r.Size, at: s.now()}
	s.mu.Unlock()
	return FilesUploadTicket{ID: id, Path: filesRoutePrefix + "upload/" + id}
}

// CancelUpload stops an upload (or drops a ticket not used yet).
func (s *FilesService) CancelUpload(id string) {
	s.mu.Lock()
	delete(s.pending, id)
	st := s.active[id]
	s.mu.Unlock()
	if st != nil {
		// Unblocks a chunk mid-copy; that chunk's handler (or the next
		// one) answers "cancelled".
		st.cancel()
		_ = st.pw.CloseWithError(context.Canceled)
		go func() {
			st.chunk.Lock()
			defer st.chunk.Unlock()
			if !st.ended {
				<-st.done
				s.endStream(st)
			}
		}()
	}
}

// cleanUploadName is the X-Filename: no path, no control characters, at
// most filesMaxNameBytes (the extension kept). The renderer sanitises the
// name the user typed the same way; this is the shell's own check.
func cleanUploadName(raw string) string {
	raw = strings.ToValidUTF8(raw, "")
	if i := strings.LastIndexAny(raw, `/\`); i >= 0 {
		raw = raw[i+1:]
	}
	var b strings.Builder
	for _, r := range raw {
		if unicode.IsControl(r) || strings.ContainsRune(`<>:"|?*`, r) {
			continue
		}
		b.WriteRune(r)
	}
	name := strings.Trim(strings.TrimSpace(b.String()), ".")
	name = strings.TrimSpace(name)
	if name == "" {
		name = "file"
	}
	if len(name) > filesMaxNameBytes {
		ext := ""
		if i := strings.LastIndexByte(name, '.'); i > 0 && len(name)-i <= 16 {
			ext = name[i:]
		}
		stem := name[:len(name)-len(ext)]
		cut := filesMaxNameBytes - len(ext)
		for cut > 0 && !utf8.RuneStart(stem[cut]) {
			cut--
		}
		name = stem[:cut] + ext
	}
	return name
}

// ServeHTTP serves /_boson/files/ on the app's own origin (assetHandler).
func (s *FilesService) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	rest := strings.TrimPrefix(r.URL.Path, filesRoutePrefix)
	switch {
	case strings.HasPrefix(rest, "upload/"):
		s.serveUpload(w, r, strings.TrimPrefix(rest, "upload/"))
	case rest == "view":
		s.serveView(w, r)
	default:
		http.NotFound(w, r)
	}
}

func filesJSONError(w http.ResponseWriter, status int, code, msg string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]string{"error": code, "message": msg})
}

// The upload protocol (renderer: modules/files/files.service.ts): the File
// goes in chunks, each POSTed as an ArrayBuffer body to the ticket's path
// with ?offset=<bytes before it>, in order and one at a time. The webviews
// don't all pass a Blob/File request body on to a custom-scheme handler:
// WKWebView (Wails' macOS asset server) hands over none at all — no
// HTTPBody, no HTTPBodyStream, no Content-Length — so a File POSTed whole
// arrived as an empty body. An ArrayBuffer body arrives, on every webview;
// none of them says how long it is, so the shell counts.
//
// The first chunk starts the request to the files host (Content-Length:
// the declared size); every chunk is piped into it as it arrives, so
// neither side holds more than a chunk. A chunk that isn't the last is
// answered 202 with X-Boson-Upload: more; the last one (or any chunk the
// files host answered early, refusing the upload) gets the files host's
// answer. Bytes past the declared size, a chunk out of order or an empty
// one fail the upload (400/409), as does no chunk for filesChunkIdle.
const (
	filesUploadMoreHeader = "X-Boson-Upload"
	filesChunkIdle        = 2 * time.Minute
)

// filesStream is an upload in flight: the request to the files host,
// reading from pw's pipe.
type filesStream struct {
	id     string
	up     *filesUpload
	chunk  sync.Mutex // one chunk at a time
	pw     *io.PipeWriter
	cancel context.CancelFunc
	idle   *time.Timer
	done   chan struct{} // the files host answered (or the request failed)

	received int64 // guarded by chunk
	ended    bool  // guarded by chunk: answered or failed; no more chunks

	// Set before done closes.
	status     int
	answer     []byte
	retryAfter string
	err        error
}

func (s *FilesService) serveUpload(w http.ResponseWriter, r *http.Request, id string) {
	if r.Method != http.MethodPost {
		filesJSONError(w, http.StatusMethodNotAllowed, "method_not_allowed", "POST only")
		return
	}
	offset := int64(0)
	if v := r.URL.Query().Get("offset"); v != "" {
		n, err := strconv.ParseInt(v, 10, 64)
		if err != nil || n < 0 {
			filesJSONError(w, http.StatusBadRequest, "bad_offset", "bad offset")
			return
		}
		offset = n
	}
	st, status, code, msg := s.uploadStream(id, offset)
	if st == nil {
		filesJSONError(w, status, code, msg)
		return
	}
	st.chunk.Lock()
	defer st.chunk.Unlock()
	if st.ended {
		filesJSONError(w, http.StatusConflict, "upload_ended", "this upload has ended")
		return
	}
	st.idle.Stop()
	if offset != st.received {
		s.failStream(st)
		filesJSONError(w, http.StatusConflict, "out_of_order", "chunk out of order")
		return
	}
	// The file's last byte goes to the files host only once this chunk is
	// known to end there: with all size bytes the files host may store the
	// file and answer before the chunk's extra bytes are seen.
	left := st.up.size - st.received
	n, err := io.Copy(st.pw, io.LimitReader(r.Body, left-1))
	st.received += n
	var tail [2]byte
	m := 0
	if err == nil && n == left-1 {
		m, _ = io.ReadFull(r.Body, tail[:])
		if m == 2 {
			s.failStream(st)
			filesJSONError(w, http.StatusBadRequest, "size_mismatch", "the body is not the declared size")
			return
		}
		if m == 1 {
			_, err = st.pw.Write(tail[:1])
			if err == nil {
				st.received++
			}
		}
	}
	if err != nil {
		if errors.Is(err, io.ErrClosedPipe) {
			// The files host has answered already (refused the upload
			// part-way, say): pass that on.
			s.finishStream(w, st)
			return
		}
		s.failStream(st)
		filesJSONError(w, http.StatusBadRequest, "read_failed", "couldn't read the upload: "+err.Error())
		return
	}
	if n == 0 && m == 0 {
		s.failStream(st)
		filesJSONError(w, http.StatusBadRequest, "empty_chunk", "the webview sent an empty chunk")
		return
	}
	if st.received < st.up.size {
		st.idle.Reset(filesChunkIdle)
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set(filesUploadMoreHeader, "more")
		w.WriteHeader(http.StatusAccepted)
		_ = json.NewEncoder(w).Encode(map[string]int64{"received": st.received})
		return
	}
	_ = st.pw.Close()
	s.finishStream(w, st)
}

// uploadStream is id's upload in flight, started by its first chunk (the
// ticket used up then).
func (s *FilesService) uploadStream(id string, offset int64) (*filesStream, int, string, string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if st := s.active[id]; st != nil {
		return st, 0, "", ""
	}
	up := s.pending[id]
	if up == nil || s.now().Sub(up.at) > filesPendingTTL {
		delete(s.pending, id)
		return nil, http.StatusNotFound, "no_upload", "unknown or expired upload"
	}
	if offset != 0 {
		return nil, http.StatusConflict, "out_of_order", "an upload starts at offset 0"
	}
	delete(s.pending, id)
	st := s.startStream(id, up)
	s.active[id] = st
	return st, 0, "", ""
}

// startStream opens the request to the files host (s.mu held).
func (s *FilesService) startStream(id string, up *filesUpload) *filesStream {
	ctx, cancel := context.WithCancel(context.Background())
	pr, pw := io.Pipe()
	st := &filesStream{id: id, up: up, pw: pw, cancel: cancel, done: make(chan struct{})}
	st.idle = time.AfterFunc(filesChunkIdle, func() {
		st.chunk.Lock()
		defer st.chunk.Unlock()
		if !st.ended {
			s.failStream(st)
		}
	})
	st.idle.Stop()
	body := &progressReader{r: pr, total: up.size, report: func(sent int64) {
		s.send(FilesProgressEvent, FilesProgress{ID: id, Sent: sent, Total: up.size})
	}}
	go func() {
		defer close(st.done)
		// The files host may answer before reading everything: later
		// chunks then see a closed pipe and fetch this answer.
		defer pr.CloseWithError(io.ErrClosedPipe)
		req, err := http.NewRequestWithContext(ctx, http.MethodPost, up.base+"/v1/files", exactReader(body, up.size))
		if err != nil {
			st.err = err
			return
		}
		req.ContentLength = up.size
		req.Header.Set("Content-Type", up.ctype)
		req.Header.Set("X-Filename", url.PathEscape(up.name))
		req.Header.Set("Accept", "application/json")
		req.Header.Set("User-Agent", "Boson")
		if up.auth != "" {
			req.Header.Set("Authorization", up.auth)
		}
		s.send(FilesProgressEvent, FilesProgress{ID: id, Sent: 0, Total: up.size})
		res, err := s.stream.Do(req)
		if err != nil {
			st.err = err
			return
		}
		defer res.Body.Close()
		st.answer, _ = io.ReadAll(io.LimitReader(res.Body, filesMaxAnswerBytes))
		st.status = res.StatusCode
		st.retryAfter = res.Header.Get("Retry-After")
		if res.StatusCode >= 200 && res.StatusCode < 300 {
			s.send(FilesProgressEvent, FilesProgress{ID: id, Sent: up.size, Total: up.size})
		}
	}()
	return st
}

// endStream forgets st (st.chunk held).
func (s *FilesService) endStream(st *filesStream) {
	st.ended = true
	st.idle.Stop()
	s.mu.Lock()
	if s.active[st.id] == st {
		delete(s.active, st.id)
	}
	s.mu.Unlock()
}

// failStream aborts st: the files host sees the request cut off, never a
// short file (st.chunk held).
func (s *FilesService) failStream(st *filesStream) {
	s.endStream(st)
	st.cancel()
	_ = st.pw.CloseWithError(errors.New("upload aborted"))
	<-st.done
}

// finishStream waits for the files host's answer and passes it on
// (st.chunk held).
func (s *FilesService) finishStream(w http.ResponseWriter, st *filesStream) {
	<-st.done
	s.endStream(st)
	st.cancel()
	if st.err != nil {
		if errors.Is(st.err, context.Canceled) {
			filesJSONError(w, 499, "cancelled", "upload cancelled")
			return
		}
		filesJSONError(w, http.StatusBadGateway, "upload_failed", st.err.Error())
		return
	}
	w.Header().Set("Content-Type", "application/json")
	if st.retryAfter != "" {
		w.Header().Set("Retry-After", st.retryAfter)
	}
	w.WriteHeader(st.status)
	_, _ = w.Write(st.answer)
}

// progressReader reports how much has been read, at most every
// filesProgressEvery (and at the end).
type progressReader struct {
	r      io.Reader
	total  int64
	sent   int64
	last   time.Time
	report func(int64)
}

func (p *progressReader) Read(b []byte) (int, error) {
	n, err := p.r.Read(b)
	p.sent += int64(n)
	if n > 0 && (time.Since(p.last) >= filesProgressEvery || p.sent >= p.total) {
		p.last = time.Now()
		p.report(p.sent)
	}
	return n, err
}

// exactReader yields exactly size bytes of r: a short body is an error
// (not a truncated file), and anything past size is ignored.
func exactReader(r io.Reader, size int64) io.Reader {
	return &exact{r: io.LimitReader(r, size), left: size}
}

type exact struct {
	r    io.Reader
	left int64
}

func (e *exact) Read(b []byte) (int, error) {
	n, err := e.r.Read(b)
	e.left -= int64(n)
	if err == io.EOF && e.left > 0 {
		return n, io.ErrUnexpectedEOF
	}
	return n, err
}

// ---- previews ----

// filesViewHeaders are copied from the files host's answer.
var filesViewHeaders = []string{
	"Content-Type", "Content-Length", "Content-Range", "Accept-Ranges", "Cache-Control",
	"Last-Modified", "ETag", "Content-Disposition", "X-File-Expires-At", "X-File-Content-Type",
}

// serveView proxies GET/HEAD of a file (/f/<id>/<name>) on an allowed
// files host, Range included, for previews.
func (s *FilesService) serveView(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		http.Error(w, "GET or HEAD", http.StatusMethodNotAllowed)
		return
	}
	raw := r.URL.Query().Get("u")
	base, u, ok := s.trustedBase(raw)
	if !ok || !strings.HasPrefix(u.EscapedPath(), mustPath(base)+"/f/") || len(raw) > 2048 {
		http.Error(w, "not a file on a files host", http.StatusForbidden)
		return
	}
	u.Fragment = ""
	req, err := http.NewRequestWithContext(r.Context(), r.Method, u.String(), nil)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadGateway)
		return
	}
	req.Header.Set("User-Agent", "Boson")
	for _, h := range []string{"Range", "If-Range", "If-None-Match", "If-Modified-Since"} {
		if v := r.Header.Get(h); v != "" {
			req.Header.Set(h, v)
		}
	}
	res, err := s.stream.Do(req)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadGateway)
		return
	}
	defer res.Body.Close()
	for _, h := range filesViewHeaders {
		if v := res.Header.Get(h); v != "" {
			w.Header().Set(h, v)
		}
	}
	// Whatever the host says, the answer can't act as a page here.
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Content-Security-Policy", "sandbox; default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'")
	if res.StatusCode >= 300 && res.StatusCode < 400 && res.StatusCode != http.StatusNotModified {
		// Redirects aren't followed (the next hop isn't checked).
		http.Error(w, "redirected", http.StatusBadGateway)
		return
	}
	w.WriteHeader(res.StatusCode)
	if r.Method == http.MethodGet {
		_, _ = io.Copy(w, res.Body)
	}
}

func mustPath(base string) string {
	u, err := url.Parse(base)
	if err != nil {
		return ""
	}
	return strings.TrimRight(u.EscapedPath(), "/")
}

// filesViewPath is the app-origin URL that previews raw (the renderer
// builds the same string: modules/files/files-bridge.ts).
func filesViewPath(raw string) string {
	return filesRoutePrefix + "view?u=" + url.QueryEscape(raw)
}
