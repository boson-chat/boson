package commands

import (
	"context"
	"testing"
	"time"

	"github.com/boson-chat/boson/backend/internal/services/server"
	"github.com/boson-chat/boson/backend/internal/services/server/dns"
	"github.com/boson-chat/boson/backend/internal/services/user"
	"github.com/boson-chat/boson/backend/internal/testutil"

	"github.com/google/uuid"
	"github.com/lib/pq"
	"github.com/rs/zerolog"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

type matchVerifier struct{}

func (matchVerifier) Verify(context.Context, string, string, dns.Mode) (dns.Report, error) {
	return dns.Report{Success: true, Results: map[string]dns.Result{}}, nil
}

func seedCronServers(t *testing.T, sr server.ServerRepositoryImpl, ur user.UserRepositoryImpl, n int, status string) []uuid.UUID {
	t.Helper()
	uid := uuid.New()
	require.NoError(t, ur.Create(testutil.Ctx(), &user.User{
		ID: uid, Handle: "cron-" + uid.String()[:8], EncryptedUserSecret: []byte("x"),
	}))
	ids := make([]uuid.UUID, 0, n)
	for i := 0; i < n; i++ {
		tok := "tok-" + uuid.NewString()
		s := &server.Server{
			Hostname: "irc.example", Port: 6697, TLS: true, Name: "S",
			Tags: pq.StringArray{}, Languages: pq.StringArray{},
			IsNSFW:             i%2 == 0,
			VerificationStatus: status,
			VerificationToken:  &tok,
			HealthStatus:       "unknown",
			RegisteredBy:       &uid,
		}
		require.NoError(t, sr.Create(testutil.Ctx(), s))
		ids = append(ids, s.ID)
	}
	return ids
}

// Regression: the health cron went through List, which clamps Limit>100
// to 25 and drops NSFW rows, so most of the directory was never probed.
func TestHealthCron_ProbesEveryVerifiedServerIncludingNSFW(t *testing.T) {
	database := testutil.SetupDB(t)
	sr := server.NewServerRepository(database)
	ur := user.NewUserRepository(database)
	ids := seedCronServers(t, sr, ur, cronBatchSize+30, "verified")

	log := zerolog.Nop()
	probed := 0
	require.NoError(t, runHealthCronWith(testutil.Ctx(), &log, sr, func(context.Context, *server.Server) string {
		probed++
		return "up"
	}))
	assert.Equal(t, len(ids), probed)

	for _, id := range ids {
		got, err := sr.FindByID(testutil.Ctx(), id)
		require.NoError(t, err)
		assert.Equal(t, "up", got.HealthStatus)
		assert.NotNil(t, got.HealthLastCheckedAt)
	}
}

func TestVerifyCron_ReverifiesNSFWAndKeepsOwnerEdits(t *testing.T) {
	database := testutil.SetupDB(t)
	sr := server.NewServerRepository(database)
	ur := user.NewUserRepository(database)
	ids := seedCronServers(t, sr, ur, 40, "pending")

	// The cron writes only verification columns, so profile fields are
	// never part of its UPDATE (the stale-copy race itself is covered in
	// the repository tests).
	edited, err := sr.FindByID(testutil.Ctx(), ids[0])
	require.NoError(t, err)
	edited.Name = "Renamed by owner"
	require.NoError(t, sr.UpdateColumns(testutil.Ctx(), edited, "name"))

	log := zerolog.Nop()
	require.NoError(t, runVerifyCron(testutil.Ctx(), &log, sr, matchVerifier{}))

	for _, id := range ids {
		got, err := sr.FindByID(testutil.Ctx(), id)
		require.NoError(t, err)
		assert.Equal(t, "verified", got.VerificationStatus, "nsfw=%v", got.IsNSFW)
		require.NotNil(t, got.VerificationLastCheckedAt)
		assert.WithinDuration(t, time.Now(), *got.VerificationLastCheckedAt, time.Minute)
	}
	got, err := sr.FindByID(testutil.Ctx(), ids[0])
	require.NoError(t, err)
	assert.Equal(t, "Renamed by owner", got.Name)
}
