package handlers

import (
	"context"
	"net/http/httptest"
	stdhttp "net/http"
	"strings"
	"testing"

	"github.com/boson-chat/boson/backend/http/middleware"
	"github.com/boson-chat/boson/backend/internal/services/avatar"
	"github.com/boson-chat/boson/backend/internal/services/presence"

	"github.com/google/uuid"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

type stubPresence struct {
	publishFn func(ctx context.Context, uid uuid.UUID, network, nick, host, account string) (*presence.MemberPresence, error)
	lookupFn  func(ctx context.Context, network string, items []presence.LookupItem) ([]presence.LookupMatch, error)
	lastNick  string
}

func (s *stubPresence) Publish(ctx context.Context, uid uuid.UUID, network, nick, host, account string) (*presence.MemberPresence, error) {
	s.lastNick = nick
	if s.publishFn != nil {
		return s.publishFn(ctx, uid, network, nick, host, account)
	}
	return &presence.MemberPresence{UserID: uid, Network: network, Nick: nick}, nil
}
func (s *stubPresence) Lookup(ctx context.Context, network string, items []presence.LookupItem) ([]presence.LookupMatch, error) {
	if s.lookupFn != nil {
		return s.lookupFn(ctx, network, items)
	}
	return nil, nil
}

func callPresence(t *testing.T, svc presence.ServiceImpl, av avatar.ServiceImpl, p middleware.Principal, method, path, body string) *httptest.ResponseRecorder {
	t.Helper()
	mux := stdhttp.NewServeMux()
	NewPresenceHandler(svc, av).Register(mux)
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req = req.WithContext(middleware.WithUser(context.Background(), p))
	rr := httptest.NewRecorder()
	mux.ServeHTTP(rr, req)
	return rr
}

func TestPublishPresence_Success(t *testing.T) {
	svc := &stubPresence{}
	rr := callPresence(t, svc, nil, middleware.Principal{UserID: uuid.New()}, "PUT", "/me/presence",
		`{"network":"Libera","nick":"Alice","host":"user/alice","account":"acct"}`)
	assert.Equal(t, stdhttp.StatusNoContent, rr.Code)
	assert.Equal(t, "Alice", svc.lastNick)
}

func TestPublishPresence_InvalidNetwork(t *testing.T) {
	svc := &stubPresence{publishFn: func(_ context.Context, _ uuid.UUID, _, _, _, _ string) (*presence.MemberPresence, error) {
		return nil, presence.ErrInvalidNetwork
	}}
	rr := callPresence(t, svc, nil, middleware.Principal{UserID: uuid.New()}, "PUT", "/me/presence", `{"nick":"Alice"}`)
	assert.Equal(t, stdhttp.StatusBadRequest, rr.Code)
}

func TestLookupPresence_ShapesMatchesWithAvatarURL(t *testing.T) {
	key := "avatars/a.png"
	svc := &stubPresence{lookupFn: func(_ context.Context, network string, items []presence.LookupItem) ([]presence.LookupMatch, error) {
		assert.Equal(t, "Libera", network)
		assert.Len(t, items, 2)
		return []presence.LookupMatch{
			{Nick: "Alice", Handle: "alice", AvatarKey: &key},
		}, nil
	}}
	av := &fakeAvatarService{configured: true}
	rr := callPresence(t, svc, av, middleware.Principal{UserID: uuid.New()}, "POST", "/presence/lookup",
		`{"network":"Libera","members":[{"nick":"Alice","account":"acct"},{"nick":"Bob","host":"h"}]}`)
	require.Equal(t, stdhttp.StatusOK, rr.Code)
	body := rr.Body.String()
	assert.Contains(t, body, `"nick":"Alice"`)
	assert.Contains(t, body, `"handle":"alice"`)
	assert.Contains(t, body, "https://cdn.boson.chat/avatars/a.png")
}

func TestLookupPresence_InvalidNetwork(t *testing.T) {
	svc := &stubPresence{lookupFn: func(_ context.Context, _ string, _ []presence.LookupItem) ([]presence.LookupMatch, error) {
		return nil, presence.ErrInvalidNetwork
	}}
	rr := callPresence(t, svc, nil, middleware.Principal{UserID: uuid.New()}, "POST", "/presence/lookup", `{"members":[]}`)
	assert.Equal(t, stdhttp.StatusBadRequest, rr.Code)
}
