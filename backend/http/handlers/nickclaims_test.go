package handlers

import (
	"context"
	"encoding/json"
	"errors"
	stdhttp "net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/boson-chat/boson/backend/http/middleware"
	"github.com/boson-chat/boson/backend/internal/services/nickclaim"

	"github.com/google/uuid"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// stubNickClaimService captures calls + returns scripted results.
// Same lightweight pattern as stubUserService in me_test.go.
type stubNickClaimService struct {
	createClaim       func(ctx context.Context, userID uuid.UUID, serverID, accountNick string) (*nickclaim.NickClaim, error)
	getClaim          func(ctx context.Context, id, userID uuid.UUID) (*nickclaim.NickClaim, error)
	consumeIfCaptured func(ctx context.Context, id, userID uuid.UUID) (*nickclaim.NickClaim, error)
	emailFor          func(*nickclaim.NickClaim) string
}

func (s *stubNickClaimService) CreateClaim(ctx context.Context, uid uuid.UUID, sid, acct string) (*nickclaim.NickClaim, error) {
	return s.createClaim(ctx, uid, sid, acct)
}
func (s *stubNickClaimService) GetClaim(ctx context.Context, id, uid uuid.UUID) (*nickclaim.NickClaim, error) {
	return s.getClaim(ctx, id, uid)
}
func (s *stubNickClaimService) ConsumeIfCaptured(ctx context.Context, id, uid uuid.UUID) (*nickclaim.NickClaim, error) {
	return s.consumeIfCaptured(ctx, id, uid)
}
func (s *stubNickClaimService) EmailFor(c *nickclaim.NickClaim) string {
	if s.emailFor != nil {
		return s.emailFor(c)
	}
	return "reg-test-" + c.ShortToken + "@boson.chat"
}

func callNickClaims(t *testing.T, svc nickclaim.ServiceImpl, p middleware.Principal, method, path, body string) *httptest.ResponseRecorder {
	t.Helper()
	mux := stdhttp.NewServeMux()
	NewNickClaimsHandler(svc).Register(mux)

	req := httptest.NewRequest(method, path, strings.NewReader(body))
	if body != "" {
		req.Header.Set("Content-Type", "application/json")
	}
	req = req.WithContext(middleware.WithUser(context.Background(), p))
	rr := httptest.NewRecorder()
	mux.ServeHTTP(rr, req)
	return rr
}

func TestNickClaimsHandler_Create_HappyPath(t *testing.T) {
	uid := uuid.New()
	claim := &nickclaim.NickClaim{
		ID:         uuid.New(),
		UserID:     uid,
		ShortToken: "abcdefgh",
		Status:     nickclaim.StatusPending,
	}
	svc := &stubNickClaimService{
		createClaim: func(_ context.Context, gotUID uuid.UUID, sid, acct string) (*nickclaim.NickClaim, error) {
			assert.Equal(t, uid, gotUID)
			assert.Equal(t, "srv-1", sid)
			assert.Equal(t, "Nyan", acct)
			return claim, nil
		},
		emailFor: func(c *nickclaim.NickClaim) string {
			return "reg-uid-" + c.ShortToken + "@boson.chat"
		},
	}

	rr := callNickClaims(t, svc, middleware.Principal{UserID: uid},
		"POST", "/me/nick-claims",
		`{"server_id":"srv-1","account_nick":"Nyan"}`)

	require.Equal(t, stdhttp.StatusCreated, rr.Code)
	var got createNickClaimResponse
	require.NoError(t, json.NewDecoder(rr.Body).Decode(&got))
	assert.Equal(t, claim.ID.String(), got.ID)
	assert.Equal(t, "reg-uid-abcdefgh@boson.chat", got.Email)
}

func TestNickClaimsHandler_Create_RateLimited(t *testing.T) {
	svc := &stubNickClaimService{
		createClaim: func(_ context.Context, _ uuid.UUID, _, _ string) (*nickclaim.NickClaim, error) {
			return nil, nickclaim.ErrRateLimited
		},
	}
	rr := callNickClaims(t, svc, middleware.Principal{UserID: uuid.New()},
		"POST", "/me/nick-claims",
		`{"server_id":"srv-1","account_nick":"Nyan"}`)

	assert.Equal(t, stdhttp.StatusTooManyRequests, rr.Code)
	assert.Contains(t, rr.Body.String(), "rate_limited")
}

func TestNickClaimsHandler_Create_RejectsEmptyFields(t *testing.T) {
	svc := &stubNickClaimService{
		createClaim: func(_ context.Context, _ uuid.UUID, _, _ string) (*nickclaim.NickClaim, error) {
			t.Fatal("service should not be called for empty input")
			return nil, nil
		},
	}
	cases := []string{
		`{}`,
		`{"server_id":"","account_nick":"Nyan"}`,
		`{"server_id":"srv","account_nick":""}`,
		`{"server_id":"  ","account_nick":"Nyan"}`,
	}
	for _, body := range cases {
		rr := callNickClaims(t, svc, middleware.Principal{UserID: uuid.New()},
			"POST", "/me/nick-claims", body)
		assert.Equal(t, stdhttp.StatusBadRequest, rr.Code, "body: %s", body)
	}
}

func TestNickClaimsHandler_Create_InvalidJSON(t *testing.T) {
	svc := &stubNickClaimService{}
	rr := callNickClaims(t, svc, middleware.Principal{UserID: uuid.New()},
		"POST", "/me/nick-claims", "not json")
	assert.Equal(t, stdhttp.StatusBadRequest, rr.Code)
}

func TestNickClaimsHandler_Get_Pending(t *testing.T) {
	id := uuid.New()
	uid := uuid.New()
	svc := &stubNickClaimService{
		consumeIfCaptured: func(_ context.Context, gotID, gotUID uuid.UUID) (*nickclaim.NickClaim, error) {
			assert.Equal(t, id, gotID)
			assert.Equal(t, uid, gotUID)
			return &nickclaim.NickClaim{ID: id, Status: nickclaim.StatusPending}, nil
		},
	}
	rr := callNickClaims(t, svc, middleware.Principal{UserID: uid},
		"GET", "/me/nick-claims/"+id.String(), "")

	require.Equal(t, stdhttp.StatusOK, rr.Code)
	var got getNickClaimResponse
	require.NoError(t, json.NewDecoder(rr.Body).Decode(&got))
	assert.Equal(t, "pending", got.Status)
	assert.Nil(t, got.Code, "code must be hidden while pending")
}

func TestNickClaimsHandler_Get_Captured_ReturnsCode(t *testing.T) {
	id := uuid.New()
	code := "ABC123"
	svc := &stubNickClaimService{
		consumeIfCaptured: func(_ context.Context, _, _ uuid.UUID) (*nickclaim.NickClaim, error) {
			return &nickclaim.NickClaim{ID: id, Status: nickclaim.StatusCaptured, Code: &code}, nil
		},
	}
	rr := callNickClaims(t, svc, middleware.Principal{UserID: uuid.New()},
		"GET", "/me/nick-claims/"+id.String(), "")

	require.Equal(t, stdhttp.StatusOK, rr.Code)
	var got getNickClaimResponse
	require.NoError(t, json.NewDecoder(rr.Body).Decode(&got))
	assert.Equal(t, "captured", got.Status)
	require.NotNil(t, got.Code)
	assert.Equal(t, "ABC123", *got.Code)
}

func TestNickClaimsHandler_Get_Consumed_StillReturnsCode(t *testing.T) {
	// Idempotency: a client whose first poll succeeded but whose
	// HTTP response got lost in transit will retry. Second poll
	// should return the same code with status=consumed so the
	// client can match up its in-flight claim.
	id := uuid.New()
	code := "ABC123"
	consumedAt := time.Now()
	svc := &stubNickClaimService{
		consumeIfCaptured: func(_ context.Context, _, _ uuid.UUID) (*nickclaim.NickClaim, error) {
			return &nickclaim.NickClaim{
				ID:         id,
				Status:     nickclaim.StatusConsumed,
				Code:       &code,
				ConsumedAt: &consumedAt,
			}, nil
		},
	}
	rr := callNickClaims(t, svc, middleware.Principal{UserID: uuid.New()},
		"GET", "/me/nick-claims/"+id.String(), "")

	require.Equal(t, stdhttp.StatusOK, rr.Code)
	var got getNickClaimResponse
	require.NoError(t, json.NewDecoder(rr.Body).Decode(&got))
	assert.Equal(t, "consumed", got.Status)
	require.NotNil(t, got.Code)
	assert.Equal(t, "ABC123", *got.Code)
}

func TestNickClaimsHandler_Get_NotFound(t *testing.T) {
	svc := &stubNickClaimService{
		consumeIfCaptured: func(_ context.Context, _, _ uuid.UUID) (*nickclaim.NickClaim, error) {
			return nil, nickclaim.ErrNotFound
		},
	}
	rr := callNickClaims(t, svc, middleware.Principal{UserID: uuid.New()},
		"GET", "/me/nick-claims/"+uuid.New().String(), "")
	assert.Equal(t, stdhttp.StatusNotFound, rr.Code)
}

func TestNickClaimsHandler_Get_BadID(t *testing.T) {
	svc := &stubNickClaimService{
		consumeIfCaptured: func(_ context.Context, _, _ uuid.UUID) (*nickclaim.NickClaim, error) {
			t.Fatal("service should not be reached on malformed id")
			return nil, nil
		},
	}
	rr := callNickClaims(t, svc, middleware.Principal{UserID: uuid.New()},
		"GET", "/me/nick-claims/not-a-uuid", "")
	assert.Equal(t, stdhttp.StatusBadRequest, rr.Code)
}

func TestNickClaimsHandler_Get_InternalError(t *testing.T) {
	svc := &stubNickClaimService{
		consumeIfCaptured: func(_ context.Context, _, _ uuid.UUID) (*nickclaim.NickClaim, error) {
			return nil, errors.New("db down")
		},
	}
	rr := callNickClaims(t, svc, middleware.Principal{UserID: uuid.New()},
		"GET", "/me/nick-claims/"+uuid.New().String(), "")
	assert.Equal(t, stdhttp.StatusInternalServerError, rr.Code)
}
