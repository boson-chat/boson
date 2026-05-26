package user_test

import (
	"testing"

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
