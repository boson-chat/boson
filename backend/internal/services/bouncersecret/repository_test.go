package bouncersecret_test

import (
	"testing"

	"github.com/boson-chat/boson/backend/internal/services/bouncersecret"
	"github.com/boson-chat/boson/backend/internal/services/user"
	"github.com/boson-chat/boson/backend/internal/testutil"

	"github.com/google/uuid"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestBouncerSecretRepository_GetUpsertDelete(t *testing.T) {
	database := testutil.SetupDB(t)
	repo := bouncersecret.NewRepository(database)
	uid := uuid.New()
	require.NoError(t, user.NewUserRepository(database).Create(testutil.Ctx(), &user.User{
		ID:                  uid,
		Handle:              "alice",
		EncryptedUserSecret: []byte("x"),
		IsDiscoverable:      true,
	}))

	// Absent → ErrNotFound.
	_, err := repo.Get(testutil.Ctx(), uid)
	assert.ErrorIs(t, err, bouncersecret.ErrNotFound)

	// Upsert then read back.
	_, err = repo.Upsert(testutil.Ctx(), uid, []byte("ct-1"))
	require.NoError(t, err)
	got, err := repo.Get(testutil.Ctx(), uid)
	require.NoError(t, err)
	assert.Equal(t, []byte("ct-1"), got.Ciphertext)

	// Upsert again → replaces ciphertext (single row per user).
	_, err = repo.Upsert(testutil.Ctx(), uid, []byte("ct-2"))
	require.NoError(t, err)
	got, err = repo.Get(testutil.Ctx(), uid)
	require.NoError(t, err)
	assert.Equal(t, []byte("ct-2"), got.Ciphertext)

	// Delete, then it's gone.
	require.NoError(t, repo.Delete(testutil.Ctx(), uid))
	_, err = repo.Get(testutil.Ctx(), uid)
	assert.ErrorIs(t, err, bouncersecret.ErrNotFound)

	// Delete absent → idempotent (no error).
	require.NoError(t, repo.Delete(testutil.Ctx(), uid))
}

func TestBouncerSecretRepository_ScopedByUser(t *testing.T) {
	database := testutil.SetupDB(t)
	repo := bouncersecret.NewRepository(database)
	userRepo := user.NewUserRepository(database)

	a := uuid.New()
	b := uuid.New()
	require.NoError(t, userRepo.Create(testutil.Ctx(), &user.User{ID: a, Handle: "a-user", EncryptedUserSecret: []byte("x"), IsDiscoverable: true}))
	require.NoError(t, userRepo.Create(testutil.Ctx(), &user.User{ID: b, Handle: "b-user", EncryptedUserSecret: []byte("x"), IsDiscoverable: true}))

	_, err := repo.Upsert(testutil.Ctx(), a, []byte("a-secret"))
	require.NoError(t, err)

	// b sees nothing of a's.
	_, err = repo.Get(testutil.Ctx(), b)
	assert.ErrorIs(t, err, bouncersecret.ErrNotFound)
}
