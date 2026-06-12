package presence_test

import (
	"testing"

	"github.com/boson-chat/boson/backend/internal/services/presence"
	"github.com/boson-chat/boson/backend/internal/services/user"
	"github.com/boson-chat/boson/backend/internal/testutil"

	"github.com/google/uuid"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func ptr(s string) *string { return &s }

func TestPresenceRepository_UpsertIsIdempotentPerNetwork(t *testing.T) {
	database := testutil.SetupDB(t)
	repo := presence.NewRepository(database)
	uid := uuid.New()
	require.NoError(t, user.NewUserRepository(database).Create(testutil.Ctx(), &user.User{
		ID: uid, Handle: "alice", EncryptedUserSecret: []byte("x"), IsDiscoverable: true,
	}))

	_, err := repo.Upsert(testutil.Ctx(), uid, "Libera", "Alice", "h1", "acct")
	require.NoError(t, err)
	// Re-publish with a new nick/host → updates the same row, no duplicate.
	_, err = repo.Upsert(testutil.Ctx(), uid, "Libera", "Alice2", "h2", "acct")
	require.NoError(t, err)

	// A self-lookup by the new identity resolves the single row.
	matches, err := repo.Lookup(testutil.Ctx(), "Libera", []presence.LookupItem{{Nick: "Alice2", Host: "h2"}})
	require.NoError(t, err)
	require.Len(t, matches, 1)
	assert.Equal(t, "alice", matches[0].Handle)
}

func TestPresenceRepository_LookupHybrid(t *testing.T) {
	database := testutil.SetupDB(t)
	repo := presence.NewRepository(database)
	userRepo := user.NewUserRepository(database)

	a := uuid.New()
	b := uuid.New()
	require.NoError(t, userRepo.Create(testutil.Ctx(), &user.User{
		ID: a, Handle: "alice", DisplayName: ptr("Alice A"), AvatarStorageKey: ptr("avatars/a.png"),
		EncryptedUserSecret: []byte("x"), IsDiscoverable: true,
	}))
	require.NoError(t, userRepo.Create(testutil.Ctx(), &user.User{
		ID: b, Handle: "bob", EncryptedUserSecret: []byte("x"), IsDiscoverable: true,
	}))

	// alice is identified (account); bob is not (nick+host only).
	_, err := repo.Upsert(testutil.Ctx(), a, "Libera", "Alice", "user/alice", "aliceacct")
	require.NoError(t, err)
	_, err = repo.Upsert(testutil.Ctx(), b, "Libera", "Bob", "1.2.3.4", "")
	require.NoError(t, err)

	matches, err := repo.Lookup(testutil.Ctx(), "Libera", []presence.LookupItem{
		// Account match wins even though the host differs from what's stored.
		{Nick: "Alice", Host: "different-host", Account: "aliceacct"},
		// No account → nick+host fallback.
		{Nick: "Bob", Host: "1.2.3.4"},
		// Unknown user.
		{Nick: "carol", Host: "z"},
		// Right nick, wrong host, no account → no match (can't confirm).
		{Nick: "Bob", Host: "9.9.9.9"},
	})
	require.NoError(t, err)

	byNick := map[string]presence.LookupMatch{}
	for _, m := range matches {
		byNick[m.Nick] = m
	}
	require.Contains(t, byNick, "Alice")
	assert.Equal(t, "alice", byNick["Alice"].Handle)
	require.NotNil(t, byNick["Alice"].AvatarKey)
	assert.Equal(t, "avatars/a.png", *byNick["Alice"].AvatarKey)
	require.NotNil(t, byNick["Alice"].DisplayName)
	assert.Equal(t, "Alice A", *byNick["Alice"].DisplayName)

	require.Contains(t, byNick, "Bob")
	assert.Equal(t, "bob", byNick["Bob"].Handle)

	assert.NotContains(t, byNick, "carol")
}

func TestPresenceRepository_LookupOtherNetworkIsolated(t *testing.T) {
	database := testutil.SetupDB(t)
	repo := presence.NewRepository(database)
	uid := uuid.New()
	require.NoError(t, user.NewUserRepository(database).Create(testutil.Ctx(), &user.User{
		ID: uid, Handle: "alice", EncryptedUserSecret: []byte("x"), IsDiscoverable: true,
	}))
	_, err := repo.Upsert(testutil.Ctx(), uid, "Libera", "Alice", "h", "acct")
	require.NoError(t, err)

	// Same identity, different network → no match.
	matches, err := repo.Lookup(testutil.Ctx(), "OFTC", []presence.LookupItem{{Nick: "Alice", Host: "h", Account: "acct"}})
	require.NoError(t, err)
	assert.Empty(t, matches)
}
