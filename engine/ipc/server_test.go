package ipc

import (
	"context"
	"encoding/json"
	"fmt"
	"net"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// newTestServer returns a running ipc.Server backed by httptest with a known
// token. Returned URL is ws://host:port/ws (the auth token must still be
// appended as ?token=... by callers).
func newTestServer(t *testing.T) (*Server, string) {
	t.Helper()
	token := "test-token-" + fmt.Sprintf("%d", time.Now().UnixNano())
	srv := NewServer("ignored-addr", token)
	ts := httptest.NewServer(srv.mux)
	t.Cleanup(ts.Close)

	u, err := url.Parse(ts.URL)
	require.NoError(t, err)
	wsURL := "ws://" + u.Host + "/ws"
	return srv, wsURL
}

func dial(t *testing.T, wsURL, token string) *websocket.Conn {
	t.Helper()
	full := wsURL + "?token=" + url.QueryEscape(token)
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	c, _, err := websocket.Dial(ctx, full, nil)
	require.NoError(t, err)
	t.Cleanup(func() { c.Close(websocket.StatusNormalClosure, "") })
	return c
}

func writeJSON(t *testing.T, c *websocket.Conn, v any) {
	t.Helper()
	raw, err := json.Marshal(v)
	require.NoError(t, err)
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	require.NoError(t, c.Write(ctx, websocket.MessageText, raw))
}

func readJSON(t *testing.T, c *websocket.Conn) ServerMessage {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	_, data, err := c.Read(ctx)
	require.NoError(t, err)
	var msg ServerMessage
	require.NoError(t, json.Unmarshal(data, &msg))
	return msg
}

func TestServer_AuthorizeMissingToken(t *testing.T) {
	_, wsURL := newTestServer(t)
	ctx, cancel := context.WithTimeout(context.Background(), 1*time.Second)
	defer cancel()
	_, resp, err := websocket.Dial(ctx, wsURL, nil)
	assert.Error(t, err)
	if resp != nil {
		assert.Equal(t, 401, resp.StatusCode)
	}
}

func TestServer_AuthorizeWrongToken(t *testing.T) {
	_, wsURL := newTestServer(t)
	ctx, cancel := context.WithTimeout(context.Background(), 1*time.Second)
	defer cancel()
	_, resp, err := websocket.Dial(ctx, wsURL+"?token=nope", nil)
	assert.Error(t, err)
	if resp != nil {
		assert.Equal(t, 401, resp.StatusCode)
	}
}

func TestServer_AcceptsValidToken(t *testing.T) {
	srv, wsURL := newTestServer(t)
	c := dial(t, wsURL, srv.Token())
	// We expect at least no immediate disconnect.
	c.Close(websocket.StatusNormalClosure, "")
}

func TestServer_UnknownCommandRepliesError(t *testing.T) {
	srv, wsURL := newTestServer(t)
	c := dial(t, wsURL, srv.Token())

	writeJSON(t, c, ClientMessage{Type: "frobnicate"})
	msg := readJSON(t, c)
	assert.Equal(t, MsgError, msg.Type)
	assert.Contains(t, msg.Error, "unknown command")
}

func TestServer_BadJSONRepliesError(t *testing.T) {
	srv, wsURL := newTestServer(t)
	c := dial(t, wsURL, srv.Token())

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	require.NoError(t, c.Write(ctx, websocket.MessageText, []byte("not json")))

	msg := readJSON(t, c)
	assert.Equal(t, MsgError, msg.Type)
	assert.Contains(t, msg.Error, "bad json")
}

func TestServer_ConnectWithBadParamsRepliesError(t *testing.T) {
	srv, wsURL := newTestServer(t)
	c := dial(t, wsURL, srv.Token())

	// Empty hostname fails validation inside irc.New. serverId must be present
	// or the engine short-circuits with a different error before irc.New runs.
	writeJSON(t, c, ClientMessage{
		Type:   CmdConnect,
		Params: json.RawMessage(`{"serverId":"s-1","hostname":"","port":6697,"nick":"alice"}`),
	})

	// Engine sends a status:connecting then an error from irc.New, or just an error.
	got := readJSON(t, c)
	for got.Type == MsgStatus {
		got = readJSON(t, c)
	}
	assert.Equal(t, MsgError, got.Type)
}

func TestServer_ConnectWithoutServerIDRepliesError(t *testing.T) {
	srv, wsURL := newTestServer(t)
	c := dial(t, wsURL, srv.Token())

	writeJSON(t, c, ClientMessage{
		Type:   CmdConnect,
		Params: json.RawMessage(`{"hostname":"irc","port":6697,"nick":"alice"}`),
	})
	msg := readJSON(t, c)
	assert.Equal(t, MsgError, msg.Type)
	assert.Contains(t, msg.Error, "serverId is required")
}

func TestServer_DisconnectIsStatus(t *testing.T) {
	srv, wsURL := newTestServer(t)
	c := dial(t, wsURL, srv.Token())

	writeJSON(t, c, ClientMessage{
		Type:   CmdDisconnect,
		Params: json.RawMessage(`{"serverId":"s-1"}`),
	})
	msg := readJSON(t, c)
	assert.Equal(t, MsgStatus, msg.Type)
	assert.Equal(t, StateDisconnected, msg.State)
	assert.Equal(t, "s-1", msg.ServerID)
}

func TestServer_DisconnectWithoutServerIDRepliesError(t *testing.T) {
	srv, wsURL := newTestServer(t)
	c := dial(t, wsURL, srv.Token())

	writeJSON(t, c, ClientMessage{Type: CmdDisconnect})
	msg := readJSON(t, c)
	assert.Equal(t, MsgError, msg.Type)
	assert.Contains(t, msg.Error, "serverId is required")
}

func TestStripBearer(t *testing.T) {
	assert.Equal(t, "abc", stripBearer("Bearer abc"))
	assert.Equal(t, "", stripBearer("Basic abc"))
	assert.Equal(t, "", stripBearer(""))
	assert.Equal(t, "", stripBearer("Bearer"))
}

func TestGenerateToken(t *testing.T) {
	a, err := GenerateToken()
	require.NoError(t, err)
	b, err := GenerateToken()
	require.NoError(t, err)
	assert.NotEqual(t, a, b, "tokens must be random")
	assert.True(t, len(a) >= 32, "token should be at least 32 chars")
}

func TestBuildWSURL(t *testing.T) {
	got, err := BuildWSURL("127.0.0.1:7331")
	require.NoError(t, err)
	assert.Equal(t, "ws://127.0.0.1:7331/ws", got)

	_, err = BuildWSURL("")
	assert.Error(t, err)
}

func TestWriteDiscovery(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "engine.json")

	require.NoError(t, WriteDiscovery(path, "ws://127.0.0.1:7331/ws", "tok"))

	raw, err := os.ReadFile(path)
	require.NoError(t, err)
	var d Discovery
	require.NoError(t, json.Unmarshal(raw, &d))
	assert.Equal(t, "ws://127.0.0.1:7331/ws", d.URL)
	assert.Equal(t, "tok", d.Token)
	assert.Equal(t, os.Getpid(), d.PID)

	info, err := os.Stat(path)
	require.NoError(t, err)
	// 0600 perms — file holds an auth token.
	assert.Equal(t, os.FileMode(0o600), info.Mode().Perm())
}

func TestDefaultDiscoveryPath_XDG(t *testing.T) {
	t.Setenv("XDG_RUNTIME_DIR", "/run/user/1000")
	assert.Equal(t, "/run/user/1000/boson/engine.json", DefaultDiscoveryPath())
}

func TestDefaultDiscoveryPath_FallsBackToHome(t *testing.T) {
	t.Setenv("XDG_RUNTIME_DIR", "")
	got := DefaultDiscoveryPath()
	assert.True(t, strings.HasSuffix(got, "/.boson/engine.json"), "got %q", got)
}

// freePort grabs an OS-assigned port and immediately releases it. Used by
// the full ListenAndServe test below.
func freePort(t *testing.T) int {
	t.Helper()
	l, err := net.Listen("tcp", "127.0.0.1:0")
	require.NoError(t, err)
	port := l.Addr().(*net.TCPAddr).Port
	_ = l.Close()
	return port
}

func TestServer_ListenAndServe_ShutdownOnContextCancel(t *testing.T) {
	port := freePort(t)
	addr := fmt.Sprintf("127.0.0.1:%d", port)
	srv := NewServer(addr, "tok")

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- srv.ListenAndServe(ctx) }()

	// Give the server a moment to bind.
	time.Sleep(50 * time.Millisecond)

	cancel()
	select {
	case err := <-done:
		assert.NoError(t, err)
	case <-time.After(3 * time.Second):
		t.Fatal("server did not shut down after ctx cancel")
	}
}
