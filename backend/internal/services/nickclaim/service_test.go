package nickclaim_test

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/boson-chat/boson/backend/internal/services/nickclaim"

	"github.com/google/uuid"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// stubRepo records calls + returns scripted values. Service tests
// don't touch Postgres — the repo is the unit boundary, and the
// repo's own integration tests live in repository_test.go.
type stubRepo struct {
	createFn      func(ctx context.Context, userID uuid.UUID, serverID, accountNick string) (*nickclaim.NickClaim, error)
	countSinceFn  func(ctx context.Context, userID uuid.UUID, since time.Time) (int64, error)
	findByIDFn    func(ctx context.Context, id, userID uuid.UUID) (*nickclaim.NickClaim, error)
	consumeCalls  int
}

func (s *stubRepo) Create(ctx context.Context, userID uuid.UUID, serverID, accountNick string) (*nickclaim.NickClaim, error) {
	return s.createFn(ctx, userID, serverID, accountNick)
}
func (s *stubRepo) FindByID(ctx context.Context, id, userID uuid.UUID) (*nickclaim.NickClaim, error) {
	return s.findByIDFn(ctx, id, userID)
}
func (s *stubRepo) FindByShortToken(_ context.Context, _ string) (*nickclaim.NickClaim, error) {
	return nil, errors.New("not used")
}
func (s *stubRepo) MarkCaptured(_ context.Context, _ uuid.UUID, _, _ string) error {
	return errors.New("not used")
}
func (s *stubRepo) MarkConsumed(_ context.Context, _, _ uuid.UUID) error {
	s.consumeCalls++
	return nil
}
func (s *stubRepo) ExpireBefore(_ context.Context, _ time.Time) (int64, error) {
	return 0, nil
}
func (s *stubRepo) CountSince(ctx context.Context, userID uuid.UUID, since time.Time) (int64, error) {
	return s.countSinceFn(ctx, userID, since)
}
func (s *stubRepo) MailUIDCaptured(_ context.Context, _ string) (bool, error) {
	return false, nil
}
func (s *stubRepo) FindNewestPendingByNick(_ context.Context, _ string) (*nickclaim.NickClaim, error) {
	return nil, nickclaim.ErrNotFound
}

func TestService_CreateClaim_HappyPath(t *testing.T) {
	uid := uuid.New()
	expected := &nickclaim.NickClaim{ID: uuid.New(), UserID: uid, ShortToken: "abcdefgh"}

	repo := &stubRepo{
		countSinceFn: func(_ context.Context, _ uuid.UUID, _ time.Time) (int64, error) { return 0, nil },
		createFn: func(_ context.Context, uid uuid.UUID, sid, acct string) (*nickclaim.NickClaim, error) {
			assert.Equal(t, "srv-1", sid)
			assert.Equal(t, "Nyan", acct)
			return expected, nil
		},
	}
	svc := nickclaim.NewService(repo, nickclaim.Config{})

	got, err := svc.CreateClaim(context.Background(), uid, "srv-1", "Nyan")
	require.NoError(t, err)
	assert.Equal(t, expected, got)
}

func TestService_CreateClaim_RateLimited(t *testing.T) {
	repo := &stubRepo{
		countSinceFn: func(_ context.Context, _ uuid.UUID, _ time.Time) (int64, error) { return 5, nil },
		createFn: func(_ context.Context, _ uuid.UUID, _, _ string) (*nickclaim.NickClaim, error) {
			t.Fatal("Create must not be called when rate-limited")
			return nil, nil
		},
	}
	svc := nickclaim.NewService(repo, nickclaim.Config{RateLimitPerHour: 5})

	_, err := svc.CreateClaim(context.Background(), uuid.New(), "srv", "Nyan")
	assert.ErrorIs(t, err, nickclaim.ErrRateLimited)
}

func TestService_CreateClaim_RejectsEmptyInputs(t *testing.T) {
	repo := &stubRepo{
		countSinceFn: func(_ context.Context, _ uuid.UUID, _ time.Time) (int64, error) {
			t.Fatal("CountSince must not be called for invalid input")
			return 0, nil
		},
	}
	svc := nickclaim.NewService(repo, nickclaim.Config{})

	_, err := svc.CreateClaim(context.Background(), uuid.New(), "", "Nyan")
	assert.Error(t, err)

	_, err = svc.CreateClaim(context.Background(), uuid.New(), "srv", "  ")
	assert.Error(t, err)
}

func TestService_EmailFor_StripsUUIDdashes(t *testing.T) {
	c := &nickclaim.NickClaim{
		UserID:     uuid.MustParse("550e8400-e29b-41d4-a716-446655440000"),
		ShortToken: "abc12345",
	}
	svc := nickclaim.NewService(&stubRepo{}, nickclaim.Config{EmailDomain: "boson.chat"})

	got := svc.EmailFor(c)
	assert.Equal(t, "reg-550e8400e29b41d4a716446655440000-abc12345@boson.chat", got)
}

func TestService_EmailFor_DefaultsToBoSonChat(t *testing.T) {
	c := &nickclaim.NickClaim{
		UserID:     uuid.MustParse("550e8400-e29b-41d4-a716-446655440000"),
		ShortToken: "abc12345",
	}
	svc := nickclaim.NewService(&stubRepo{}, nickclaim.Config{}) // no domain
	got := svc.EmailFor(c)
	assert.Contains(t, got, "@boson.chat")
}

func TestService_ConsumeIfCaptured_FlipsCapturedToConsumed(t *testing.T) {
	id, uid := uuid.New(), uuid.New()
	row := &nickclaim.NickClaim{
		ID:     id,
		UserID: uid,
		Status: nickclaim.StatusCaptured,
	}
	// After MarkConsumed, a follow-up FindByID returns the row
	// with status = consumed.
	findCalls := 0
	repo := &stubRepo{
		findByIDFn: func(_ context.Context, gotID, gotUID uuid.UUID) (*nickclaim.NickClaim, error) {
			findCalls++
			assert.Equal(t, id, gotID)
			assert.Equal(t, uid, gotUID)
			if findCalls == 1 {
				return row, nil
			}
			updated := *row
			updated.Status = nickclaim.StatusConsumed
			return &updated, nil
		},
	}
	svc := nickclaim.NewService(repo, nickclaim.Config{})

	got, err := svc.ConsumeIfCaptured(context.Background(), id, uid)
	require.NoError(t, err)
	assert.Equal(t, nickclaim.StatusConsumed, got.Status)
	assert.Equal(t, 1, repo.consumeCalls)
}

func TestService_ConsumeIfCaptured_NoOpForOtherStatuses(t *testing.T) {
	id, uid := uuid.New(), uuid.New()
	for _, s := range []string{nickclaim.StatusPending, nickclaim.StatusConsumed, nickclaim.StatusExpired} {
		row := &nickclaim.NickClaim{ID: id, UserID: uid, Status: s}
		repo := &stubRepo{
			findByIDFn: func(_ context.Context, _, _ uuid.UUID) (*nickclaim.NickClaim, error) { return row, nil },
		}
		svc := nickclaim.NewService(repo, nickclaim.Config{})

		got, err := svc.ConsumeIfCaptured(context.Background(), id, uid)
		require.NoError(t, err, "status=%s", s)
		assert.Equal(t, s, got.Status, "status=%s should stay unchanged", s)
		assert.Equal(t, 0, repo.consumeCalls, "MarkConsumed shouldn't fire for status=%s", s)
	}
}
