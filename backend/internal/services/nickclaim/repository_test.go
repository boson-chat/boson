package nickclaim_test

import (
	"testing"
	"time"

	"github.com/boson-chat/boson/backend/internal/db"
	"github.com/boson-chat/boson/backend/internal/services/nickclaim"
	"github.com/boson-chat/boson/backend/internal/services/user"
	"github.com/boson-chat/boson/backend/internal/testutil"

	"github.com/google/uuid"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// seedUser creates a users row so nick_claims.user_id FKs satisfy.
func seedUser(t *testing.T, d *db.DB) uuid.UUID {
	t.Helper()
	repo := user.NewUserRepository(d)
	id := uuid.New()
	u := &user.User{
		ID:                  id,
		Handle:              "u-" + id.String()[:8],
		EncryptedUserSecret: []byte("blob"),
		IsDiscoverable:      true,
	}
	require.NoError(t, repo.Create(testutil.Ctx(), u))
	return id
}

func TestRepository_CreateAndFindByID(t *testing.T) {
	d := testutil.SetupDB(t)
	repo := nickclaim.NewRepository(d)
	uid := seedUser(t, d)

	c, err := repo.Create(testutil.Ctx(), uid, "srv-1", "Nyan")
	require.NoError(t, err)
	require.NotNil(t, c)
	assert.Equal(t, nickclaim.StatusPending, c.Status)
	assert.Len(t, c.ShortToken, 8, "short_token should be 8 base32 chars")
	assert.True(t, c.ExpiresAt.After(c.CreatedAt), "expires_at must be after created_at")

	got, err := repo.FindByID(testutil.Ctx(), c.ID, uid)
	require.NoError(t, err)
	assert.Equal(t, c.ID, got.ID)
	assert.Equal(t, "srv-1", got.ServerID)
	assert.Equal(t, "Nyan", got.AccountNick)
}

func TestRepository_FindByID_WrongUserIsNotFound(t *testing.T) {
	// User-scoped read: a claim that belongs to user A must NOT be
	// readable by user B even with the correct id. Defence in
	// depth on top of the handler's auth middleware.
	d := testutil.SetupDB(t)
	repo := nickclaim.NewRepository(d)
	uidA := seedUser(t, d)
	uidB := seedUser(t, d)

	c, err := repo.Create(testutil.Ctx(), uidA, "srv-1", "Nyan")
	require.NoError(t, err)

	got, err := repo.FindByID(testutil.Ctx(), c.ID, uidB)
	assert.Nil(t, got)
	assert.ErrorIs(t, err, nickclaim.ErrNotFound)
}

func TestRepository_FindByShortToken_NoUserFilter(t *testing.T) {
	// IMAP worker has no user context. FindByShortToken must
	// return any row whose token matches, regardless of user.
	d := testutil.SetupDB(t)
	repo := nickclaim.NewRepository(d)
	uid := seedUser(t, d)
	c, err := repo.Create(testutil.Ctx(), uid, "srv-1", "Nyan")
	require.NoError(t, err)

	got, err := repo.FindByShortToken(testutil.Ctx(), c.ShortToken)
	require.NoError(t, err)
	assert.Equal(t, c.ID, got.ID)

	miss, err := repo.FindByShortToken(testutil.Ctx(), "nosuchtok")
	assert.Nil(t, miss)
	assert.ErrorIs(t, err, nickclaim.ErrNotFound)
}

func TestRepository_MarkCaptured_HappyPath(t *testing.T) {
	d := testutil.SetupDB(t)
	repo := nickclaim.NewRepository(d)
	uid := seedUser(t, d)
	c, err := repo.Create(testutil.Ctx(), uid, "srv-1", "Nyan")
	require.NoError(t, err)

	require.NoError(t, repo.MarkCaptured(testutil.Ctx(), c.ID, "ABC123", "uidl-42"))

	got, err := repo.FindByID(testutil.Ctx(), c.ID, uid)
	require.NoError(t, err)
	assert.Equal(t, nickclaim.StatusCaptured, got.Status)
	require.NotNil(t, got.Code)
	assert.Equal(t, "ABC123", *got.Code)
	require.NotNil(t, got.MailUID)
	assert.Equal(t, "uidl-42", *got.MailUID)
}

func TestRepository_MarkCaptured_RejectsNonPending(t *testing.T) {
	// Defensive: capturing a row that's already captured/consumed
	// returns ErrStaleStatus so the worker can log + skip a
	// duplicate inbound mail.
	d := testutil.SetupDB(t)
	repo := nickclaim.NewRepository(d)
	uid := seedUser(t, d)
	c, err := repo.Create(testutil.Ctx(), uid, "srv-1", "Nyan")
	require.NoError(t, err)
	require.NoError(t, repo.MarkCaptured(testutil.Ctx(), c.ID, "X", "uid-1"))

	err = repo.MarkCaptured(testutil.Ctx(), c.ID, "Y", "uid-2")
	assert.ErrorIs(t, err, nickclaim.ErrStaleStatus)
}

func TestRepository_MarkConsumed_HappyPath(t *testing.T) {
	d := testutil.SetupDB(t)
	repo := nickclaim.NewRepository(d)
	uid := seedUser(t, d)
	c, err := repo.Create(testutil.Ctx(), uid, "srv-1", "Nyan")
	require.NoError(t, err)
	require.NoError(t, repo.MarkCaptured(testutil.Ctx(), c.ID, "ABC", "u"))

	require.NoError(t, repo.MarkConsumed(testutil.Ctx(), c.ID, uid))

	got, _ := repo.FindByID(testutil.Ctx(), c.ID, uid)
	assert.Equal(t, nickclaim.StatusConsumed, got.Status)
	require.NotNil(t, got.ConsumedAt)
}

func TestRepository_ExpireBefore(t *testing.T) {
	// Test seam: use NewRepositoryWithClock to mint rows with a
	// known created_at. Then advance time past TTL and run the
	// sweeper.
	d := testutil.SetupDB(t)
	t0 := time.Date(2026, 6, 1, 12, 0, 0, 0, time.UTC)
	repo := nickclaim.NewRepositoryWithClock(d, func() time.Time { return t0 })
	uid := seedUser(t, d)

	_, err := repo.Create(testutil.Ctx(), uid, "srv-1", "Nyan")
	require.NoError(t, err)
	_, err = repo.Create(testutil.Ctx(), uid, "srv-2", "Nyan2")
	require.NoError(t, err)

	// Both rows expire 30 min after t0. Sweep at t0 + 31min.
	swept, err := repo.ExpireBefore(testutil.Ctx(), t0.Add(31*time.Minute))
	require.NoError(t, err)
	assert.Equal(t, int64(2), swept)

	// Idempotent: re-sweep at the same instant moves zero rows
	// (the previously-pending rows are now 'expired').
	swept, err = repo.ExpireBefore(testutil.Ctx(), t0.Add(31*time.Minute))
	require.NoError(t, err)
	assert.Equal(t, int64(0), swept)
}

func TestRepository_CountSince(t *testing.T) {
	d := testutil.SetupDB(t)
	t0 := time.Date(2026, 6, 1, 12, 0, 0, 0, time.UTC)
	repo := nickclaim.NewRepositoryWithClock(d, func() time.Time { return t0 })
	uid := seedUser(t, d)
	otherUID := seedUser(t, d)

	for i := 0; i < 3; i++ {
		_, err := repo.Create(testutil.Ctx(), uid, "srv", "n"+string(rune('a'+i)))
		require.NoError(t, err)
	}
	// Another user's row shouldn't count toward uid's quota.
	_, err := repo.Create(testutil.Ctx(), otherUID, "srv", "other")
	require.NoError(t, err)

	n, err := repo.CountSince(testutil.Ctx(), uid, t0.Add(-time.Hour))
	require.NoError(t, err)
	assert.Equal(t, int64(3), n)

	// `since` after all rows → zero.
	n, err = repo.CountSince(testutil.Ctx(), uid, t0.Add(time.Hour))
	require.NoError(t, err)
	assert.Equal(t, int64(0), n)
}
