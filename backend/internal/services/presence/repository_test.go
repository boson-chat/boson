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

func TestPresenceRepository_LookupExcludesNonDiscoverable(t *testing.T) {
	database := testutil.SetupDB(t)
	repo := presence.NewRepository(database)
	userRepo := user.NewUserRepository(database)

	hidden := uuid.New()
	require.NoError(t, userRepo.Create(testutil.Ctx(), &user.User{
		ID: hidden, Handle: "hidden", EncryptedUserSecret: []byte("x"), IsDiscoverable: false,
	}))
	// The users model carries `default:true`, so gorm substitutes the column
	// default for a false IsDiscoverable on INSERT; flip it explicitly.
	require.NoError(t, database.DB.Exec("UPDATE users SET is_discoverable = false WHERE id = ?", hidden).Error)
	_, err := repo.Upsert(testutil.Ctx(), hidden, "Libera", "Hidden", "h", "hiddenacct")
	require.NoError(t, err)

	matches, err := repo.Lookup(testutil.Ctx(), "Libera", []presence.LookupItem{
		{Nick: "Hidden", Host: "h", Account: "hiddenacct"},
		{Nick: "Hidden", Host: "h"},
	})
	require.NoError(t, err)
	assert.Empty(t, matches, "users who opted out of discovery must not be identifiable")
}

// A second user self-reporting an account someone else already published
// must not be able to put their profile on that account's nick. Contested
// keys resolve to nobody, deterministically, regardless of row order.
func TestPresenceRepository_LookupContestedAccountMatchesNobody(t *testing.T) {
	database := testutil.SetupDB(t)
	repo := presence.NewRepository(database)
	userRepo := user.NewUserRepository(database)

	victim := uuid.New()
	squatter := uuid.New()
	require.NoError(t, userRepo.Create(testutil.Ctx(), &user.User{
		ID: victim, Handle: "victim", EncryptedUserSecret: []byte("x"), IsDiscoverable: true,
	}))
	require.NoError(t, userRepo.Create(testutil.Ctx(), &user.User{
		ID: squatter, Handle: "squatter", EncryptedUserSecret: []byte("x"), IsDiscoverable: true,
	}))
	_, err := repo.Upsert(testutil.Ctx(), victim, "Libera", "Victim", "user/victim", "VictimAcct")
	require.NoError(t, err)
	_, err = repo.Upsert(testutil.Ctx(), squatter, "Libera", "Squatter", "1.2.3.4", "victimacct")
	require.NoError(t, err)

	for i := 0; i < 5; i++ {
		matches, err := repo.Lookup(testutil.Ctx(), "Libera", []presence.LookupItem{
			// Contested account, host that matches neither row.
			{Nick: "Victim", Host: "elsewhere", Account: "VictimAcct"},
		})
		require.NoError(t, err)
		assert.Empty(t, matches)
	}

	// The uncontested nick+host fallback still identifies the real member.
	matches, err := repo.Lookup(testutil.Ctx(), "Libera", []presence.LookupItem{
		{Nick: "Victim", Host: "user/victim", Account: "VictimAcct"},
	})
	require.NoError(t, err)
	require.Len(t, matches, 1)
	assert.Equal(t, "victim", matches[0].Handle)
}

func TestPresenceRepository_LookupContestedNickHostMatchesNobody(t *testing.T) {
	database := testutil.SetupDB(t)
	repo := presence.NewRepository(database)
	userRepo := user.NewUserRepository(database)

	for _, h := range []string{"one", "two"} {
		id := uuid.New()
		require.NoError(t, userRepo.Create(testutil.Ctx(), &user.User{
			ID: id, Handle: h, EncryptedUserSecret: []byte("x"), IsDiscoverable: true,
		}))
		_, err := repo.Upsert(testutil.Ctx(), id, "Libera", "Same", "same.host", "")
		require.NoError(t, err)
	}

	matches, err := repo.Lookup(testutil.Ctx(), "Libera", []presence.LookupItem{{Nick: "same", Host: "same.host"}})
	require.NoError(t, err)
	assert.Empty(t, matches)
}
