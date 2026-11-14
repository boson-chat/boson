package http

import (
	"context"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	stdhttp "net/http"

	"github.com/boson-chat/boson/backend/config"
	"github.com/boson-chat/boson/backend/http/handlers"
	"github.com/boson-chat/boson/backend/internal/services/nickclaim"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// fakeWorker stands in for the POP3 worker so the reload tests can see
// starts and stops without a mail server.
type fakeWorker struct {
	cfg     nickclaim.WorkerConfig
	running atomic.Bool
}

func (w *fakeWorker) Run(ctx context.Context) {
	w.running.Store(true)
	<-ctx.Done()
	w.running.Store(false)
}
func (w *fakeWorker) Health() nickclaim.WorkerHealth {
	return nickclaim.WorkerHealth{Running: w.running.Load()}
}

type workers struct {
	mu   sync.Mutex
	list []*fakeWorker
}

func (ws *workers) new(cfg nickclaim.WorkerConfig) nickclaim.WorkerRunner {
	w := &fakeWorker{cfg: cfg}
	ws.mu.Lock()
	ws.list = append(ws.list, w)
	ws.mu.Unlock()
	return w
}

// running returns the hosts of the workers running now.
func (ws *workers) running() []string {
	ws.mu.Lock()
	defer ws.mu.Unlock()
	out := []string{}
	for _, w := range ws.list {
		if w.running.Load() {
			out = append(out, w.cfg.Host)
		}
	}
	return out
}

func (ws *workers) started() int {
	ws.mu.Lock()
	defer ws.mu.Unlock()
	return len(ws.list)
}

func newReloadRig(t *testing.T) (nickclaim.ServiceImpl, *nickclaim.Runtime, *workers, context.Context) {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	claims := nickclaim.NewService(nil, nickclaim.Config{})
	ws := &workers{}
	rt := nickclaim.NewRuntimeWith(ctx, claims, ws.new, func(context.Context, nickclaim.WorkerConfig) (int, error) { return 0, nil })
	t.Cleanup(rt.Stop)
	return claims, rt, ws, ctx
}

func writeAtomic(t *testing.T, path, content string) {
	t.Helper()
	tmp, err := os.CreateTemp(filepath.Dir(path), ".boson-*.yaml")
	require.NoError(t, err)
	_, err = tmp.WriteString(content)
	require.NoError(t, err)
	require.NoError(t, tmp.Close())
	require.NoError(t, os.Rename(tmp.Name(), path))
}

func publicConfig(t *testing.T, claims nickclaim.ServiceImpl) string {
	t.Helper()
	mux := stdhttp.NewServeMux()
	handlers.NewPublicConfigHandler(claims).Register(mux)
	rr := httptest.NewRecorder()
	mux.ServeHTTP(rr, httptest.NewRequest("GET", "/config", nil))
	return rr.Body.String()
}

const enabledA = `version: 1
nick_claim:
  enabled: true
  email_domain: example.com
  inbound:
    host: a.example.com
    user: reg@example.com
`

func TestNickClaimConfig_EnvOnlyDefaultsOff(t *testing.T) {
	claims, rt, ws, ctx := newReloadRig(t)
	status, err := startNickClaimConfig(ctx, config.Config{}, rt)
	require.NoError(t, err)
	assert.Nil(t, status, "no BOSON_CONFIG: no config status")
	assert.False(t, claims.Enabled())
	assert.Empty(t, ws.running())
	assert.JSONEq(t, `{"nick_claim":false}`, publicConfig(t, claims))
}

func TestNickClaimConfig_EnvEnabledInvalidStaysOff(t *testing.T) {
	claims, rt, ws, ctx := newReloadRig(t)
	cfg := config.Config{AppConfig: config.AppConfig{NickClaimEnabled: true}}
	_, err := startNickClaimConfig(ctx, cfg, rt)
	require.NoError(t, err)
	assert.False(t, claims.Enabled())
	assert.Empty(t, ws.running())
	assert.Contains(t, rt.Settings().ConfigError, "inbound.host")
}

func TestNickClaimConfig_EnvEnabled(t *testing.T) {
	claims, rt, ws, ctx := newReloadRig(t)
	cfg := config.Config{AppConfig: config.AppConfig{
		NickClaimEnabled: true, NickClaimEmailDomain: "boson.chat",
		PurelyMailPOP3Host: "legacy.example.com", PurelyMailPOP3Port: 995,
	}}
	_, err := startNickClaimConfig(ctx, cfg, rt)
	require.NoError(t, err)
	assert.True(t, claims.Enabled())
	require.Eventually(t, func() bool { return len(ws.running()) == 1 }, 2*time.Second, 10*time.Millisecond)
	assert.Equal(t, []string{"legacy.example.com"}, ws.running())
}

func TestNickClaimConfig_HotReload(t *testing.T) {
	claims, rt, ws, ctx := newReloadRig(t)
	prev := configPoll
	configPoll = 100 * time.Millisecond // fsnotify registers asynchronously
	t.Cleanup(func() { configPoll = prev })
	path := filepath.Join(t.TempDir(), "boson.yaml")
	require.NoError(t, os.WriteFile(path, []byte("version: 1\nnick_claim:\n  enabled: false\n"), 0o644))

	cfg := config.Config{StackConfig: config.StackConfig{Path: path}}
	cfg.AppConfig.NickClaimPOP3Password = "env-secret"
	status, err := startNickClaimConfig(ctx, cfg, rt)
	require.NoError(t, err)
	require.NotNil(t, status)
	assert.True(t, status().OK)
	assert.False(t, claims.Enabled())
	assert.Empty(t, ws.running())

	// Enable: the worker starts, the public capability flips.
	writeAtomic(t, path, enabledA)
	require.Eventually(t, func() bool { return len(ws.running()) == 1 }, 5*time.Second, 20*time.Millisecond)
	assert.True(t, claims.Enabled())
	assert.Equal(t, "example.com", claims.CurrentConfig().EmailDomain)
	assert.JSONEq(t, `{"nick_claim":true}`, publicConfig(t, claims))
	assert.Equal(t, "env-secret", rt.Settings().Inbound.Password, "the password comes from env")

	// Inbound change: restart against the new host.
	writeAtomic(t, path, enabledA+"    port: 1995\n")
	require.Eventually(t, func() bool {
		r := ws.running()
		return len(r) == 1 && ws.started() == 2
	}, 5*time.Second, 20*time.Millisecond)
	assert.Equal(t, 1995, rt.Settings().Inbound.Port)

	// Broken file: last good config stays, status reports the error.
	writeAtomic(t, path, "version: 1\nnick_claim:\n  enabled: [oops\n")
	require.Eventually(t, func() bool { return !status().OK }, 5*time.Second, 20*time.Millisecond)
	assert.True(t, claims.Enabled())
	assert.Len(t, ws.running(), 1)
	assert.NotZero(t, status().ErrorLine)

	// Disable: the worker stops.
	writeAtomic(t, path, "version: 1\nnick_claim:\n  enabled: false\n")
	require.Eventually(t, func() bool { return len(ws.running()) == 0 }, 5*time.Second, 20*time.Millisecond)
	assert.False(t, claims.Enabled())
	assert.True(t, status().OK)
	assert.JSONEq(t, `{"nick_claim":false}`, publicConfig(t, claims))

	// Enable again, then remove the file: back to env (off by default).
	writeAtomic(t, path, enabledA)
	require.Eventually(t, func() bool { return len(ws.running()) == 1 }, 5*time.Second, 20*time.Millisecond)
	require.NoError(t, os.Remove(path))
	require.Eventually(t, func() bool { return len(ws.running()) == 0 }, 5*time.Second, 20*time.Millisecond)
	assert.False(t, claims.Enabled())
}

func TestNickClaimConfig_InvalidAtStartupRunsOnEnv(t *testing.T) {
	claims, rt, ws, ctx := newReloadRig(t)
	path := filepath.Join(t.TempDir(), "boson.yaml")
	require.NoError(t, os.WriteFile(path, []byte("nick_claim:\n  enabled: true\n"), 0o644)) // no host
	status, err := startNickClaimConfig(ctx, config.Config{StackConfig: config.StackConfig{Path: path}}, rt)
	require.NoError(t, err)
	assert.False(t, status().OK)
	assert.Contains(t, status().Error, "email_domain is not set")
	assert.False(t, claims.Enabled())
	assert.Empty(t, ws.running())
}

func TestBuildRouter_ConfigBypassesAuth(t *testing.T) {
	publicMux := stdhttp.NewServeMux()
	publicMux.HandleFunc("GET /config", func(w stdhttp.ResponseWriter, _ *stdhttp.Request) {
		_, _ = w.Write([]byte("public:config"))
	})
	hits := []string{}
	router := buildRouter(publicMux, stdhttp.NewServeMux(), recordingAuth(&hits))
	rr := httptest.NewRecorder()
	router.ServeHTTP(rr, httptest.NewRequest("GET", "/config", nil))
	assert.Equal(t, "public:config", rr.Body.String())
	assert.Empty(t, hits)
}
