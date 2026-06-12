package nickservsecret_test

import (
	"testing"

	"github.com/boson-chat/boson/backend/internal/services/nickservsecret"
	"github.com/boson-chat/boson/backend/internal/services/user"
	"github.com/boson-chat/boson/backend/internal/testutil"

	"github.com/google/uuid"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestNickservSecretRepository_UpsertListDelete(t *testing.T) {
	database := testutil.SetupDB(t)
	repo := nickservsecret.NewRepository(database)
	uid := uuid.New()
	require.NoError(t, user.NewUserRepository(database).Create(testutil.Ctx(), &user.User{
		ID:                  uid,
		Handle:              "alice",
		EncryptedUserSecret: []byte("x"),
		IsDiscoverable:      true,
	}))

	// Upsert two servers.
	_, err := repo.Upsert(testutil.Ctx(), uid, "srv-1", []byte("ct-1"))
	require.NoError(t, err)
	_, err = repo.Upsert(testutil.Ctx(), uid, "srv-2", []byte("ct-2"))
	require.NoError(t, err)

	// Upsert again on srv-1 → replaces ciphertext (no duplicate row).
	_, err = repo.Upsert(testutil.Ctx(), uid, "srv-1", []byte("ct-1b"))
	require.NoError(t, err)

	list, err := repo.List(testutil.Ctx(), uid)
	require.NoError(t, err)
	require.Len(t, list, 2)
	assert.Equal(t, "srv-1", list[0].ServerID)
	assert.Equal(t, []byte("ct-1b"), list[0].Ciphertext)
	assert.Equal(t, "srv-2", list[1].ServerID)

	// Delete srv-1.
	require.NoError(t, repo.Delete(testutil.Ctx(), uid, "srv-1"))
	list, err = repo.List(testutil.Ctx(), uid)
	require.NoError(t, err)
	require.Len(t, list, 1)
	assert.Equal(t, "srv-2", list[0].ServerID)

	// Delete absent → ErrNotFound.
	assert.ErrorIs(t, repo.Delete(testutil.Ctx(), uid, "srv-1"), nickservsecret.ErrNotFound)
}

func TestNickservSecretRepository_ListScopedByUser(t *testing.T) {
	database := testutil.SetupDB(t)
	repo := nickservsecret.NewRepository(database)
	userRepo := user.NewUserRepository(database)

	a := uuid.New()
	b := uuid.New()
	require.NoError(t, userRepo.Create(testutil.Ctx(), &user.User{ID: a, Handle: "a-user", EncryptedUserSecret: []byte("x"), IsDiscoverable: true}))
	require.NoError(t, userRepo.Create(testutil.Ctx(), &user.User{ID: b, Handle: "b-user", EncryptedUserSecret: []byte("x"), IsDiscoverable: true}))

	_, err := repo.Upsert(testutil.Ctx(), a, "srv-1", []byte("a-secret"))
	require.NoError(t, err)

	// b sees nothing of a's.
	list, err := repo.List(testutil.Ctx(), b)
	require.NoError(t, err)
	assert.Empty(t, list)
}
