package server_test

import (
	"testing"
	"time"

	"github.com/boson-chat/boson/backend/internal/services/server"
	"github.com/boson-chat/boson/backend/internal/services/user"
	"github.com/boson-chat/boson/backend/internal/testutil"

	"github.com/google/uuid"
	"github.com/lib/pq"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// seedUser creates a user row needed for the servers.registered_by FK.
func seedUser(t *testing.T, ur user.UserRepositoryImpl) uuid.UUID {
	t.Helper()
	id := uuid.New()
	require.NoError(t, ur.Create(testutil.Ctx(), &user.User{
		ID:                  id,
		Handle:              "registrar-" + id.String()[:8],
		EncryptedUserSecret: []byte("x"),
		IsDiscoverable:      true,
	}))
	return id
}

func seedServer(t *testing.T, repo server.ServerRepositoryImpl, registeredBy uuid.UUID, name string, tags, langs []string, nsfw bool) *server.Server {
	t.Helper()
	desc := name + " description"
	if tags == nil {
		tags = []string{}
	}
	if langs == nil {
		langs = []string{}
	}
	s := &server.Server{
		Hostname:           "irc.example",
		Port:               6697,
		TLS:                true,
		Name:               name,
		Description:        &desc,
		Tags:               pq.StringArray(tags),
		Languages:          pq.StringArray(langs),
		IsNSFW:             nsfw,
		VerificationStatus: "pending",
		HealthStatus:       "unknown",
		RegisteredBy:       &registeredBy,
	}
	require.NoError(t, repo.Create(testutil.Ctx(), s))
	return s
}

func TestServerRepository_CreateAndFindByID(t *testing.T) {
	db := testutil.SetupDB(t)
	ur := user.NewUserRepository(db)
	sr := server.NewServerRepository(db)
	uid := seedUser(t, ur)

	created := seedServer(t, sr, uid, "Libera", []string{"foss"}, []string{"en"}, false)
	assert.NotEqual(t, uuid.Nil, created.ID, "DB should populate the UUID via DEFAULT")

	got, err := sr.FindByID(testutil.Ctx(), created.ID)
	require.NoError(t, err)
	assert.Equal(t, "Libera", got.Name)
	assert.Equal(t, []string{"foss"}, []string(got.Tags))
}

// Regression: GORM `default:` tags silently substituted the DB default for
// zero-value bools, which made TLS=false at the API turn into TLS=true on read.
func TestServerRepository_PersistsTLSFalse(t *testing.T) {
	db := testutil.SetupDB(t)
	ur := user.NewUserRepository(db)
	sr := server.NewServerRepository(db)
	uid := seedUser(t, ur)

	s := &server.Server{
		Hostname:           "irc.example",
		Port:               6667,
		TLS:                false,
		Name:               "Plain",
		Tags:               pq.StringArray{},
		Languages:          pq.StringArray{},
		IsNSFW:             false,
		VerificationStatus: "pending",
		HealthStatus:       "unknown",
		RegisteredBy:       &uid,
	}
	require.NoError(t, sr.Create(testutil.Ctx(), s))

	got, err := sr.FindByID(testutil.Ctx(), s.ID)
	require.NoError(t, err)
	assert.False(t, got.TLS, "TLS=false must not be silently substituted with the DB default")
	assert.False(t, got.IsNSFW, "IsNSFW=false must persist")
	assert.False(t, got.IsFeatured, "IsFeatured=false must persist")
}

func TestServerRepository_FindByID_NotFound(t *testing.T) {
	db := testutil.SetupDB(t)
	sr := server.NewServerRepository(db)
	got, err := sr.FindByID(testutil.Ctx(), uuid.New())
	assert.Nil(t, got)
	assert.ErrorIs(t, err, server.ErrNotFound)
}

func TestServerRepository_List_ExcludesNSFWByDefault(t *testing.T) {
	db := testutil.SetupDB(t)
	ur := user.NewUserRepository(db)
	sr := server.NewServerRepository(db)
	uid := seedUser(t, ur)

	seedServer(t, sr, uid, "Safe", nil, nil, false)
	seedServer(t, sr, uid, "NSFW", nil, nil, true)

	got, err := sr.List(testutil.Ctx(), server.ListFilter{})
	require.NoError(t, err)
	assert.Len(t, got, 1)
	assert.Equal(t, "Safe", got[0].Name)
}

func TestServerRepository_List_IncludeNSFW(t *testing.T) {
	db := testutil.SetupDB(t)
	ur := user.NewUserRepository(db)
	sr := server.NewServerRepository(db)
	uid := seedUser(t, ur)

	seedServer(t, sr, uid, "Safe", nil, nil, false)
	seedServer(t, sr, uid, "NSFW", nil, nil, true)

	got, err := sr.List(testutil.Ctx(), server.ListFilter{IncludeNSFW: true})
	require.NoError(t, err)
	assert.Len(t, got, 2)
}

func TestServerRepository_List_LanguageFilter(t *testing.T) {
	db := testutil.SetupDB(t)
	ur := user.NewUserRepository(db)
	sr := server.NewServerRepository(db)
	uid := seedUser(t, ur)

	seedServer(t, sr, uid, "English", nil, []string{"en"}, false)
	seedServer(t, sr, uid, "French", nil, []string{"fr"}, false)
	seedServer(t, sr, uid, "Multi", nil, []string{"en", "fr"}, false)

	got, err := sr.List(testutil.Ctx(), server.ListFilter{Language: "fr"})
	require.NoError(t, err)
	names := nameList(got)
	assert.Contains(t, names, "French")
	assert.Contains(t, names, "Multi")
	assert.NotContains(t, names, "English")
}

// Regression for the "Myelin matches Myelinbots" / "Libera matches Libera.Chat"
// bug. Postgres FTS without prefix matching only finds whole tokens, so
// "Myelin" finding "Myelinbots" needs to_tsquery('simple', 'myelin:*').
func TestServerRepository_List_PrefixSearch(t *testing.T) {
	db := testutil.SetupDB(t)
	ur := user.NewUserRepository(db)
	sr := server.NewServerRepository(db)
	uid := seedUser(t, ur)

	desc1 := "MyelinBots IRC Network"
	require.NoError(t, sr.Create(testutil.Ctx(), &server.Server{
		Hostname: "irc.myelinbots.com", Port: 6697, TLS: true,
		Name: "Myelinbots", Description: &desc1, RegisteredBy: &uid,
		Tags: pq.StringArray{}, Languages: pq.StringArray{},
		VerificationStatus: "pending", HealthStatus: "unknown",
	}))
	desc2 := "FOSS-focused IRC network"
	require.NoError(t, sr.Create(testutil.Ctx(), &server.Server{
		Hostname: "irc.libera.chat", Port: 6697, TLS: true,
		Name: "Libera.Chat", Description: &desc2, RegisteredBy: &uid,
		Tags: pq.StringArray{}, Languages: pq.StringArray{},
		VerificationStatus: "pending", HealthStatus: "unknown",
	}))

	cases := map[string]string{
		"Myelin":   "Myelinbots",
		"myelin":   "Myelinbots",
		"Libera":   "Libera.Chat",
		"liber":    "Libera.Chat",
		"libera.c": "Libera.Chat",
	}
	for q, want := range cases {
		t.Run("q="+q, func(t *testing.T) {
			got, err := sr.List(testutil.Ctx(), server.ListFilter{Query: q})
			require.NoError(t, err)
			require.Len(t, got, 1, "expected exactly one match for %q", q)
			assert.Equal(t, want, got[0].Name)
		})
	}
}

func TestServerRepository_List_PrefixSearch_MultiWord(t *testing.T) {
	db := testutil.SetupDB(t)
	ur := user.NewUserRepository(db)
	sr := server.NewServerRepository(db)
	uid := seedUser(t, ur)

	desc := "Open and Free Technology Community"
	require.NoError(t, sr.Create(testutil.Ctx(), &server.Server{
		Hostname: "irc.oftc.net", Port: 6697, TLS: true,
		Name: "OFTC", Description: &desc, RegisteredBy: &uid,
		Tags: pq.StringArray{}, Languages: pq.StringArray{},
		VerificationStatus: "pending", HealthStatus: "unknown",
	}))

	got, err := sr.List(testutil.Ctx(), server.ListFilter{Query: "open free"})
	require.NoError(t, err)
	require.Len(t, got, 1)
	assert.Equal(t, "OFTC", got[0].Name)
}

func TestServerRepository_List_FullTextSearch(t *testing.T) {
	db := testutil.SetupDB(t)
	ur := user.NewUserRepository(db)
	sr := server.NewServerRepository(db)
	uid := seedUser(t, ur)

	desc1 := "FOSS-focused IRC network"
	require.NoError(t, sr.Create(testutil.Ctx(), &server.Server{
		Hostname: "irc.libera.chat", Port: 6697, TLS: true,
		Name: "Libera", Description: &desc1, RegisteredBy: &uid,
		Tags: pq.StringArray{}, Languages: pq.StringArray{},
		VerificationStatus: "pending", HealthStatus: "unknown",
	}))
	desc2 := "Gaming community"
	require.NoError(t, sr.Create(testutil.Ctx(), &server.Server{
		Hostname: "irc.example", Port: 6697, TLS: true,
		Name: "GameNet", Description: &desc2, RegisteredBy: &uid,
		Tags: pq.StringArray{}, Languages: pq.StringArray{},
		VerificationStatus: "pending", HealthStatus: "unknown",
	}))

	got, err := sr.List(testutil.Ctx(), server.ListFilter{Query: "foss"})
	require.NoError(t, err)
	require.Len(t, got, 1)
	assert.Equal(t, "Libera", got[0].Name)

	got, err = sr.List(testutil.Ctx(), server.ListFilter{Query: "gaming"})
	require.NoError(t, err)
	require.Len(t, got, 1)
	assert.Equal(t, "GameNet", got[0].Name)
}

func TestServerRepository_List_DefaultLimit(t *testing.T) {
	db := testutil.SetupDB(t)
	ur := user.NewUserRepository(db)
	sr := server.NewServerRepository(db)
	uid := seedUser(t, ur)

	for i := 0; i < 30; i++ {
		seedServer(t, sr, uid, "Server", nil, nil, false)
	}

	got, err := sr.List(testutil.Ctx(), server.ListFilter{})
	require.NoError(t, err)
	assert.Len(t, got, 25, "default limit is 25")
}

func TestServerRepository_List_OffsetPagination(t *testing.T) {
	db := testutil.SetupDB(t)
	ur := user.NewUserRepository(db)
	sr := server.NewServerRepository(db)
	uid := seedUser(t, ur)

	for i := 0; i < 5; i++ {
		seedServer(t, sr, uid, "Server", nil, nil, false)
	}

	page1, err := sr.List(testutil.Ctx(), server.ListFilter{Limit: 2, Offset: 0})
	require.NoError(t, err)
	page2, err := sr.List(testutil.Ctx(), server.ListFilter{Limit: 2, Offset: 2})
	require.NoError(t, err)
	assert.Len(t, page1, 2)
	assert.Len(t, page2, 2)
	assert.NotEqual(t, page1[0].ID, page2[0].ID)
}

func nameList(servers []*server.Server) []string {
	out := make([]string, len(servers))
	for i, s := range servers {
		out[i] = s.Name
	}
	return out
}

// Regression: Update used gorm Save (every column), so a stale row held
// by the cron or an HTTP handler reverted concurrent edits. UpdateColumns
// must leave unnamed columns alone.
func TestServerRepository_UpdateColumns_DoesNotRevertOtherColumns(t *testing.T) {
	db := testutil.SetupDB(t)
	ur := user.NewUserRepository(db)
	sr := server.NewServerRepository(db)
	uid := seedUser(t, ur)
	s := seedServer(t, sr, uid, "Original", nil, nil, false)

	// Writer A holds a stale copy.
	stale, err := sr.FindByID(testutil.Ctx(), s.ID)
	require.NoError(t, err)

	// Writer B (owner) renames + sets an icon in the meantime.
	fresh, err := sr.FindByID(testutil.Ctx(), s.ID)
	require.NoError(t, err)
	fresh.Name = "Renamed"
	icon := "servers/icon/x.png"
	fresh.IconStorageKey = &icon
	require.NoError(t, sr.UpdateColumns(testutil.Ctx(), fresh, "name", "icon_storage_key"))

	// Writer A records a health result from its stale copy.
	stale.HealthStatus = "up"
	require.NoError(t, sr.UpdateColumns(testutil.Ctx(), stale, "health_status"))

	got, err := sr.FindByID(testutil.Ctx(), s.ID)
	require.NoError(t, err)
	assert.Equal(t, "Renamed", got.Name)
	require.NotNil(t, got.IconStorageKey)
	assert.Equal(t, icon, *got.IconStorageKey)
	assert.Equal(t, "up", got.HealthStatus)
}

func TestServerRepository_UpdateColumns_WritesZeroValues(t *testing.T) {
	db := testutil.SetupDB(t)
	ur := user.NewUserRepository(db)
	sr := server.NewServerRepository(db)
	uid := seedUser(t, ur)
	s := seedServer(t, sr, uid, "Zero", []string{"a"}, nil, true)

	s.Description = nil
	s.IsNSFW = false
	s.Tags = pq.StringArray{}
	require.NoError(t, sr.UpdateColumns(testutil.Ctx(), s, "description", "is_nsfw", "tags"))

	got, err := sr.FindByID(testutil.Ctx(), s.ID)
	require.NoError(t, err)
	assert.Nil(t, got.Description)
	assert.False(t, got.IsNSFW)
	assert.Empty(t, []string(got.Tags))
}

func TestServerRepository_ListBatchForCron_CoversEverythingIncludingNSFW(t *testing.T) {
	db := testutil.SetupDB(t)
	ur := user.NewUserRepository(db)
	sr := server.NewServerRepository(db)
	uid := seedUser(t, ur)

	// More rows than List's 25-row clamp, a third of them NSFW, plus a
	// lapsed row that must be excluded by the status filter.
	want := map[uuid.UUID]bool{}
	for i := 0; i < 60; i++ {
		s := seedServer(t, sr, uid, "S", nil, nil, i%3 == 0)
		s.VerificationStatus = "verified"
		require.NoError(t, sr.UpdateColumns(testutil.Ctx(), s, "verification_status"))
		want[s.ID] = true
	}
	lapsed := seedServer(t, sr, uid, "Lapsed", nil, nil, false)
	lapsed.VerificationStatus = "lapsed"
	require.NoError(t, sr.UpdateColumns(testutil.Ctx(), lapsed, "verification_status"))

	got := map[uuid.UUID]bool{}
	after := uuid.Nil
	pages := 0
	for {
		batch, err := sr.ListBatchForCron(testutil.Ctx(), []string{"verified"}, after, 25)
		require.NoError(t, err)
		pages++
		for _, s := range batch {
			assert.False(t, got[s.ID], "keyset pagination must not repeat rows")
			got[s.ID] = true
		}
		if len(batch) < 25 {
			break
		}
		after = batch[len(batch)-1].ID
	}
	assert.Equal(t, want, got)
	assert.Equal(t, 3, pages)
}

func TestServerRepository_RecordVerifyResult_GuardsOnToken(t *testing.T) {
	db := testutil.SetupDB(t)
	ur := user.NewUserRepository(db)
	sr := server.NewServerRepository(db)
	uid := seedUser(t, ur)
	s := seedServer(t, sr, uid, "Guarded", nil, nil, false)
	tok := "current-token"
	s.VerificationToken = &tok
	require.NoError(t, sr.UpdateColumns(testutil.Ctx(), s, "verification_token"))

	now := time.Now().UTC().Truncate(time.Microsecond)

	// Stale token (owner regenerated mid-run) → nothing written.
	applied, err := sr.RecordVerifyResult(testutil.Ctx(), s.ID, "old-token", "verified", now)
	require.NoError(t, err)
	assert.False(t, applied)
	got, err := sr.FindByID(testutil.Ctx(), s.ID)
	require.NoError(t, err)
	assert.Equal(t, "pending", got.VerificationStatus)
	assert.Nil(t, got.VerificationLastCheckedAt)

	// Matching token → status + timestamp written, profile untouched.
	applied, err = sr.RecordVerifyResult(testutil.Ctx(), s.ID, tok, "verified", now)
	require.NoError(t, err)
	assert.True(t, applied)
	got, err = sr.FindByID(testutil.Ctx(), s.ID)
	require.NoError(t, err)
	assert.Equal(t, "verified", got.VerificationStatus)
	require.NotNil(t, got.VerificationLastCheckedAt)
	assert.True(t, now.Equal(*got.VerificationLastCheckedAt))
	assert.Equal(t, "Guarded", got.Name)
}

func TestServerRepository_RecordHealthResult(t *testing.T) {
	db := testutil.SetupDB(t)
	ur := user.NewUserRepository(db)
	sr := server.NewServerRepository(db)
	uid := seedUser(t, ur)
	s := seedServer(t, sr, uid, "Health", nil, nil, false)

	now := time.Now().UTC().Truncate(time.Microsecond)
	require.NoError(t, sr.RecordHealthResult(testutil.Ctx(), s.ID, "down", now))

	got, err := sr.FindByID(testutil.Ctx(), s.ID)
	require.NoError(t, err)
	assert.Equal(t, "down", got.HealthStatus)
	require.NotNil(t, got.HealthLastCheckedAt)
	assert.True(t, now.Equal(*got.HealthLastCheckedAt))
}
