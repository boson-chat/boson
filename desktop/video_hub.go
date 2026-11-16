package main

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"net"
	"net/http"
	"sync"
	"time"

	"github.com/coder/websocket"
)

// frameHub serves received video to the webview: a WebSocket on
// 127.0.0.1 (random port) with a per-launch secret in the URL. Wails
// events carry JSON (base64 for ~10 Mbit/s of video is wasteful) and the
// asset server's custom scheme doesn't stream reliably on WKWebView.
//
// Binary messages are frames (encodeFrameMsg) and self-preview pictures;
// text messages are JSON (lip-sync offsets out, keyframe requests in).
type frameHub struct {
	key string
	ln  net.Listener
	srv *http.Server
	// onKeyframe: the page's decoder needs a keyframe for this track.
	onKeyframe func(trackID uint32)

	mu    sync.Mutex
	conns map[*hubConn]struct{}
}

// hubConn is one page connection. Frames queue per connection; a page that
// falls behind skips to the next keyframe of each track instead of
// decoding a broken stream.
type hubConn struct {
	out     chan []byte
	needKey map[uint32]bool // track → drop until a keyframe (guarded by hub.mu)
	done    chan struct{}
}

const hubQueue = 64

func newFrameHub(onKeyframe func(uint32)) (*frameHub, error) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return nil, err
	}
	var k [16]byte
	_, _ = rand.Read(k[:])
	h := &frameHub{key: hex.EncodeToString(k[:]), ln: ln, onKeyframe: onKeyframe, conns: map[*hubConn]struct{}{}}
	mux := http.NewServeMux()
	mux.HandleFunc("/video", h.serve)
	h.srv = &http.Server{Handler: mux, ReadHeaderTimeout: 5 * time.Second}
	go func() { _ = h.srv.Serve(ln) }()
	return h, nil
}

// URL is what the page connects to.
func (h *frameHub) URL() string {
	return "ws://" + h.ln.Addr().String() + "/video?k=" + h.key
}

func (h *frameHub) Close() {
	_ = h.srv.Close()
}

func (h *frameHub) serve(w http.ResponseWriter, r *http.Request) {
	if subtle.ConstantTimeCompare([]byte(r.URL.Query().Get("k")), []byte(h.key)) != 1 {
		http.Error(w, "forbidden", http.StatusForbidden)
		return
	}
	// The secret is the authorization; the page's origin is the app's own
	// (wails://, http://wails.localhost) and differs per platform.
	ws, err := websocket.Accept(w, r, &websocket.AcceptOptions{InsecureSkipVerify: true})
	if err != nil {
		return
	}
	ws.SetReadLimit(64 << 10)
	c := &hubConn{out: make(chan []byte, hubQueue), needKey: map[uint32]bool{}, done: make(chan struct{})}
	h.mu.Lock()
	h.conns[c] = struct{}{}
	h.mu.Unlock()
	defer func() {
		h.mu.Lock()
		delete(h.conns, c)
		h.mu.Unlock()
		close(c.done)
	}()
	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()
	go h.readLoop(ctx, ws, cancel)
	for {
		select {
		case <-ctx.Done():
			_ = ws.Close(websocket.StatusNormalClosure, "")
			return
		case msg := <-c.out:
			typ := websocket.MessageBinary
			if len(msg) > 0 && msg[0] == '{' {
				typ = websocket.MessageText
			}
			wctx, wcancel := context.WithTimeout(ctx, 5*time.Second)
			err := ws.Write(wctx, typ, msg)
			wcancel()
			if err != nil {
				return
			}
		}
	}
}

// hubRequest is a text message from the page.
type hubRequest struct {
	Type    string `json:"type"` // "keyframe"
	TrackID uint32 `json:"trackId"`
}

func (h *frameHub) readLoop(ctx context.Context, ws *websocket.Conn, cancel func()) {
	defer cancel()
	for {
		typ, b, err := ws.Read(ctx)
		if err != nil {
			return
		}
		if typ != websocket.MessageText {
			continue
		}
		var req hubRequest
		if json.Unmarshal(b, &req) == nil && req.Type == "keyframe" && h.onKeyframe != nil {
			h.onKeyframe(req.TrackID)
		}
	}
}

// Frame sends a video frame to every page.
func (h *frameHub) Frame(trackID, layer uint32, captureUS uint64, f avcFrame) {
	var msg []byte
	h.mu.Lock()
	defer h.mu.Unlock()
	for c := range h.conns {
		if c.needKey[trackID] {
			if !f.Keyframe || len(f.Desc) == 0 {
				continue
			}
			delete(c.needKey, trackID)
		}
		if msg == nil {
			msg = encodeFrameMsg(trackID, layer, captureUS, f)
		}
		select {
		case c.out <- msg:
		default:
			// Behind: skip this track to its next keyframe, and ask for one.
			c.needKey[trackID] = true
			if h.onKeyframe != nil {
				go h.onKeyframe(trackID)
			}
		}
	}
}

// Text sends a JSON message to every page (dropped for a page that is
// behind: these are periodic).
func (h *frameHub) Text(v any) {
	b, err := json.Marshal(v)
	if err != nil {
		return
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	for c := range h.conns {
		select {
		case c.out <- b:
		default:
		}
	}
}

// Preview sends our camera's self-view (RGBA, small): u8 2, u16 w, u16 h,
// then w*h*4 bytes.
func (h *frameHub) Preview(w, hgt int, rgba []byte) {
	msg := make([]byte, 0, 5+len(rgba))
	msg = append(msg, previewVersion, byte(w>>8), byte(w), byte(hgt>>8), byte(hgt))
	msg = append(msg, rgba...)
	h.mu.Lock()
	defer h.mu.Unlock()
	for c := range h.conns {
		select {
		case c.out <- msg:
		default:
		}
	}
}

const previewVersion = 2

// connected says whether a page is connected (tests).
func (h *frameHub) connected() int {
	h.mu.Lock()
	defer h.mu.Unlock()
	return len(h.conns)
}
