package user_test

import (
	"testing"
	"time"

	"github.com/boson-chat/boson/backend/internal/services/user"
	"github.com/boson-chat/boson/backend/internal/testutil"

	"github.com/google/uuid"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestUserRepository_CreateAndFindByID(t *testing.T) {
	db := testutil.SetupDB(t)
	repo := user.NewUserRepository(db)

	id := uuid.New()
	u := &user.User{
		ID:                  id,
		Handle:              "alice",
		EncryptedUserSecret: []byte("ciphertext"),
		IsDiscoverable:      true,
	}
	require.NoError(t, repo.Create(testutil.Ctx(), u))

	got, err := repo.FindByID(testutil.Ctx(), id)
	require.NoError(t, err)
	assert.Equal(t, "alice", got.Handle)
	assert.Equal(t, []byte("ciphertext"), got.EncryptedUserSecret)
}

func TestUserRepository_UpdateUserSecretWraps(t *testing.T) {
	db := testutil.SetupDB(t)
	repo := user.NewUserRepository(db)

	id := uuid.New()
	require.NoError(t, repo.Create(testutil.Ctx(), &user.User{
		ID:                  id,
		Handle:              "alice",
		EncryptedUserSecret: []byte("pw-wrap-v1"),
		IsDiscoverable:      true,
	}))

	// Enroll a recovery wrap (password wrap left untouched via nil).
	_, err := repo.UpdateUserSecretWraps(testutil.Ctx(), id, nil, []byte("recovery-wrap"))
	require.NoError(t, err)
	got, err := repo.FindByID(testutil.Ctx(), id)
	require.NoError(t, err)
	assert.Equal(t, []byte("pw-wrap-v1"), got.EncryptedUserSecret, "password wrap untouched")
	assert.Equal(t, []byte("recovery-wrap"), got.EncryptedUserSecretRecovery)

	// Re-wrap the password (recovery left untouched).
	_, err = repo.UpdateUserSecretWraps(testutil.Ctx(), id, []byte("pw-wrap-v2"), nil)
	require.NoError(t, err)
	got, err = repo.FindByID(testutil.Ctx(), id)
	require.NoError(t, err)
	assert.Equal(t, []byte("pw-wrap-v2"), got.EncryptedUserSecret)
	assert.Equal(t, []byte("recovery-wrap"), got.EncryptedUserSecretRecovery, "recovery wrap untouched")
}

func TestUserRepository_UpdateUserSecretWraps_NotFound(t *testing.T) {
	db := testutil.SetupDB(t)
	repo := user.NewUserRepository(db)
	_, err := repo.UpdateUserSecretWraps(testutil.Ctx(), uuid.New(), []byte("x"), nil)
	assert.ErrorIs(t, err, user.ErrNotFound)
}

func TestUserRepository_FindByID_NotFound(t *testing.T) {
	db := testutil.SetupDB(t)
	repo := user.NewUserRepository(db)

	got, err := repo.FindByID(testutil.Ctx(), uuid.New())
	assert.Nil(t, got)
	assert.ErrorIs(t, err, user.ErrNotFound)
}

func TestUserRepository_FindByHandle_CaseInsensitive(t *testing.T) {
	db := testutil.SetupDB(t)
	repo := user.NewUserRepository(db)

	require.NoError(t, repo.Create(testutil.Ctx(), &user.User{
		ID:                  uuid.New(),
		Handle:              "MixedCase",
		EncryptedUserSecret: []byte("x"),
		IsDiscoverable:      true,
	}))

	got, err := repo.FindByHandle(testutil.Ctx(), "mixedcase")
	require.NoError(t, err)
	assert.Equal(t, "MixedCase", got.Handle)
}

func TestUserRepository_FindByHandle_NotFound(t *testing.T) {
	db := testutil.SetupDB(t)
	repo := user.NewUserRepository(db)

	got, err := repo.FindByHandle(testutil.Ctx(), "nobody")
	assert.Nil(t, got)
	assert.ErrorIs(t, err, user.ErrNotFound)
}

func TestUserRepository_Create_DuplicateHandle(t *testing.T) {
	db := testutil.SetupDB(t)
	repo := user.NewUserRepository(db)

	first := &user.User{ID: uuid.New(), Handle: "twin", EncryptedUserSecret: []byte("x")}
	require.NoError(t, repo.Create(testutil.Ctx(), first))

	second := &user.User{ID: uuid.New(), Handle: "twin", EncryptedUserSecret: []byte("y")}
	err := repo.Create(testutil.Ctx(), second)
	assert.Error(t, err, "expected unique-index violation")
}

func TestUserRepository_UpdateHandle_Renames_AndWritesAudit(t *testing.T) {
	db := testutil.SetupDB(t)
	repo := user.NewUserRepository(db)

	id := uuid.New()
	require.NoError(t, repo.Create(testutil.Ctx(), &user.User{
		ID:                  id,
		Handle:              "old",
		EncryptedUserSecret: []byte("x"),
	}))

	before := time.Now().UTC()
	updated, err := repo.UpdateHandle(testutil.Ctx(), id, "new")
	require.NoError(t, err)
	assert.Equal(t, "new", updated.Handle)
	require.NotNil(t, updated.HandleChangedAt)
	assert.WithinDuration(t, before, *updated.HandleChangedAt, 5*time.Second)

	// Refetch from the DB to confirm it persisted (not just held in struct).
	got, err := repo.FindByID(testutil.Ctx(), id)
	require.NoError(t, err)
	assert.Equal(t, "new", got.Handle)

	// Audit row written.
	var audit user.HandleChange
	require.NoError(t, db.DB.Where("user_id = ?", id).First(&audit).Error)
	assert.Equal(t, "old", audit.OldHandle)
	assert.Equal(t, "new", audit.NewHandle)
	assert.True(t, audit.RedirectUntil.After(audit.ChangedAt))
}

func TestUserRepository_UpdateHandle_NotFound(t *testing.T) {
	db := testutil.SetupDB(t)
	repo := user.NewUserRepository(db)

	_, err := repo.UpdateHandle(testutil.Ctx(), uuid.New(), "new")
	assert.ErrorIs(t, err, user.ErrNotFound)
}

func TestUserRepository_UpdateHandle_DuplicateHandleRejected(t *testing.T) {
	db := testutil.SetupDB(t)
	repo := user.NewUserRepository(db)

	taken := &user.User{ID: uuid.New(), Handle: "taken", EncryptedUserSecret: []byte("x")}
	require.NoError(t, repo.Create(testutil.Ctx(), taken))
	mover := &user.User{ID: uuid.New(), Handle: "mover", EncryptedUserSecret: []byte("y")}
	require.NoError(t, repo.Create(testutil.Ctx(), mover))

	_, err := repo.UpdateHandle(testutil.Ctx(), mover.ID, "taken")
	assert.Error(t, err, "expected unique-index violation on duplicate handle")
}

// Same-string rename is a no-op: returns the existing row without
// writing an audit entry. Matches the service-layer expectation that
// re-saving the current handle does nothing visible.
func TestUserRepository_UpdateHandle_NoOpSameHandle(t *testing.T) {
	db := testutil.SetupDB(t)
	repo := user.NewUserRepository(db)

	id := uuid.New()
	require.NoError(t, repo.Create(testutil.Ctx(), &user.User{
		ID:                  id,
		Handle:              "alice",
		EncryptedUserSecret: []byte("x"),
	}))

	got, err := repo.UpdateHandle(testutil.Ctx(), id, "alice")
	require.NoError(t, err)
	assert.Equal(t, "alice", got.Handle)
	assert.Nil(t, got.HandleChangedAt, "no-op rename must not bump handle_changed_at")

	var count int64
	require.NoError(t, db.DB.Model(&user.HandleChange{}).Where("user_id = ?", id).Count(&count).Error)
	assert.EqualValues(t, 0, count, "no audit row for no-op rename")
}
