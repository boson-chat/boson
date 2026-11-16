package main

import (
	"context"
	"encoding/binary"
	"encoding/json"
	"net/http"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"
)

func dialHub(t *testing.T, h *frameHub) *websocket.Conn {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	ws, _, err := websocket.Dial(ctx, h.URL(), nil)
	if err != nil {
		t.Fatal(err)
	}
	ws.SetReadLimit(4 << 20)
	t.Cleanup(func() { _ = ws.CloseNow() })
	deadline := time.Now().Add(2 * time.Second)
	for h.connected() == 0 && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
	return ws
}

func readMsg(t *testing.T, ws *websocket.Conn) (websocket.MessageType, []byte) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	typ, b, err := ws.Read(ctx)
	if err != nil {
		t.Fatal(err)
	}
	return typ, b
}

func TestHubRefusesWithoutKey(t *testing.T) {
	h, err := newFrameHub(nil)
	if err != nil {
		t.Fatal(err)
	}
	defer h.Close()
	u := strings.Replace(h.URL(), "ws://", "http://", 1)
	u = u[:strings.Index(u, "?")] + "?k=wrong"
	res, err := http.Get(u)
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if res.StatusCode != http.StatusForbidden {
		t.Fatalf("status %d", res.StatusCode)
	}
	if !strings.HasPrefix(h.URL(), "ws://127.0.0.1:") {
		t.Fatalf("not loopback: %s", h.URL())
	}
}

// Frames, sync messages and the self-view reach the page; the page's
// keyframe requests reach Go.
func TestHubFramesTextAndRequests(t *testing.T) {
	var mu sync.Mutex
	var asked []uint32
	h, err := newFrameHub(func(id uint32) { mu.Lock(); asked = append(asked, id); mu.Unlock() })
	if err != nil {
		t.Fatal(err)
	}
	defer h.Close()
	ws := dialHub(t, h)

	h.Frame(9, 1, 42, avcFrame{Data: []byte{0, 0, 0, 1, 0x65}, Desc: []byte{1}, Keyframe: true})
	typ, b := readMsg(t, ws)
	if typ != websocket.MessageBinary || b[0] != frameVersion || binary.BigEndian.Uint32(b[2:]) != 9 {
		t.Fatalf("frame %v %x", typ, b)
	}

	h.Text(syncMsg{Type: "sync", Offsets: map[uint32]int64{9: -1234}})
	typ, b = readMsg(t, ws)
	var sm syncMsg
	if typ != websocket.MessageText || json.Unmarshal(b, &sm) != nil || sm.Offsets[9] != -1234 {
		t.Fatalf("sync %v %s", typ, b)
	}

	h.Preview(2, 1, []byte{1, 2, 3, 4, 5, 6, 7, 8})
	_, b = readMsg(t, ws)
	if b[0] != previewVersion || b[2] != 2 || b[4] != 1 || len(b) != 5+8 {
		t.Fatalf("preview %x", b)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	if err := ws.Write(ctx, websocket.MessageText, []byte(`{"type":"keyframe","trackId":9}`)); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(2 * time.Second)
	for {
		mu.Lock()
		n := len(asked)
		mu.Unlock()
		if n == 1 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("keyframe request didn't arrive")
		}
		time.Sleep(5 * time.Millisecond)
	}
}

// A page that falls behind skips the track to its next keyframe (a broken
// stream can't be decoded) and a keyframe is asked for.
func TestHubSkipsToKeyframeWhenBehind(t *testing.T) {
	var mu sync.Mutex
	asked := 0
	h := &frameHub{conns: map[*hubConn]struct{}{}, onKeyframe: func(uint32) { mu.Lock(); asked++; mu.Unlock() }}
	c := &hubConn{out: make(chan []byte, 2), needKey: map[uint32]bool{}}
	h.conns[c] = struct{}{}
	delta := avcFrame{Data: []byte{1}}
	key := avcFrame{Data: []byte{1}, Desc: []byte{1}, Keyframe: true}
	h.Frame(1, 0, 1, delta)
	h.Frame(1, 0, 2, delta)
	h.Frame(1, 0, 3, delta) // queue full: dropped, track now waits for a key
	<-c.out
	<-c.out
	h.Frame(1, 0, 4, delta) // still waiting: dropped
	if len(c.out) != 0 {
		t.Fatal("a delta frame was sent after a gap")
	}
	h.Frame(1, 0, 5, key)
	if len(c.out) != 1 || c.needKey[1] {
		t.Fatal("the keyframe should resume the track")
	}
	time.Sleep(20 * time.Millisecond)
	mu.Lock()
	defer mu.Unlock()
	if asked == 0 {
		t.Fatal("no keyframe asked for")
	}
}
