package supabaseimport

import (
	"fmt"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestSanitizeNick(t *testing.T) {
	cases := map[string]string{
		"alice":                                "alice",
		"Alice.Smith":                          "Alice_Smith",
		"john+boson":                           "john_boson",
		"  spaced  out ":                       "spaced_out",
		"123abc":                               "u123abc",
		"-dash":                                "u-dash",
		"[bot]":                                "[bot]",
		"NickServ":                             "NickServ_",
		"émile":                                "mile",
		"":                                     "",
		"...":                                  "",
		"abcdefghijklmnopqrstuvwxyz0123456789": "abcdefghijklmnopqrstuvwxyz0123",
	}
	for in, want := range cases {
		got := sanitizeNick(in)
		assert.Equal(t, want, got, "sanitizeNick(%q)", in)
		if got != "" {
			assert.True(t, validNick(got), "%q not valid", got)
		}
	}
}

func TestUniqueNickUsesRFC1459Folding(t *testing.T) {
	taken := map[string]struct{}{foldNick("[Bot]"): {}, foldNick("bob"): {}, foldNick("bob2"): {}}
	assert.Equal(t, "{bot}2", uniqueNick("{bot}", taken))
	assert.Equal(t, "Bob3", uniqueNick("Bob", taken))
	long := "abcdefghijklmnopqrstuvwxyz0123"
	taken[foldNick(long)] = struct{}{}
	got := uniqueNick(long, taken)
	assert.Len(t, got, 30)
	assert.Equal(t, "abcdefghijklmnopqrstuvwxyz0122", got)
}

func ts(s string) *time.Time { t, _ := time.Parse(time.RFC3339, s); return &t }

func TestPlan(t *testing.T) {
	now := time.Date(2026, 11, 13, 0, 0, 0, 0, time.UTC)
	hash := "$2a$10$" + "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0" // 60 chars
	require.Len(t, hash, 60)
	ids := make([]uuid.UUID, 12)
	for i := range ids {
		ids[i] = uuid.New()
	}
	users := []SupabaseUser{
		{ID: ids[0], Email: "alice@example.com", EncryptedPassword: hash, EmailConfirmedAt: ts("2025-01-01T00:00:00Z")},
		{ID: ids[1], Email: "bob@example.com", EncryptedPassword: hash, Metadata: map[string]any{"username": "Bob"}},
		{ID: ids[2], Email: "carol.x@example.com", EmailConfirmedAt: ts("2025-01-01T00:00:00Z")},
		{ID: ids[3], Email: "dave@example.com", DeletedAt: ts("2025-01-01T00:00:00Z")},
		{ID: ids[4], Email: "", IsAnonymous: true},
		{ID: ids[5], Email: "", EncryptedPassword: hash},
		{ID: ids[6], Email: "ALICE@example.com"},
		{ID: ids[7], Email: "taken@example.com", EmailConfirmedAt: ts("2025-01-01T00:00:00Z")},
		{ID: ids[8], Email: "squat@example.com"},
		{ID: ids[9], Email: "banned@example.com", BannedUntil: ts("2099-01-01T00:00:00Z"), EncryptedPassword: hash},
		{ID: ids[10], Email: "again@example.com"},
		{ID: ids[11], Email: "bob@other.example", EncryptedPassword: hash},
	}
	in := Inputs{
		BosonHandles:   map[uuid.UUID]string{ids[0]: "Alice.B"},
		Mapped:         map[uuid.UUID]string{ids[10]: "usr_EXISTING"},
		TakenUsernames: map[string]struct{}{foldNick("bob"): {}},
		ExistingByEmail: map[string]ExistingAuthUser{
			"taken@example.com": {ID: "usr_T", Username: "taken", EmailVerified: true},
			"squat@example.com": {ID: "usr_S", Username: "squat", EmailVerified: false},
		},
		NewID: func() func() string { n := 0; return func() string { n++; return fmt.Sprintf("usr_%d", n) } }(),
	}
	plan := Plan(users, in, Options{Passwords: PasswordsBcrypt, Now: now})
	by := map[uuid.UUID]Planned{}
	for _, p := range plan {
		by[p.Supabase.ID] = p
	}

	a := by[ids[0]]
	assert.Equal(t, ActionCreate, a.Action)
	assert.Equal(t, "Alice_B", a.Username)
	assert.Equal(t, "boson_handle", a.UsernameSource)
	assert.True(t, a.EmailVerified)
	assert.Equal(t, hash, a.PasswordHash)

	b := by[ids[1]]
	assert.Equal(t, "Bob2", b.Username, "bob is taken in the auth service")
	assert.Equal(t, "metadata:username", b.UsernameSource)
	assert.True(t, b.Renamed)
	assert.False(t, b.EmailVerified)

	c := by[ids[2]]
	assert.Equal(t, "carol_x", c.Username)
	assert.Equal(t, "", c.PasswordHash, "OAuth/magic-link user")
	assert.Contains(t, c.Note, "needs a reset")

	assert.Equal(t, ActionSkip, by[ids[3]].Action)
	assert.Equal(t, ActionSkip, by[ids[4]].Action)
	assert.Equal(t, ActionConflict, by[ids[5]].Action)
	assert.Equal(t, ActionConflict, by[ids[6]].Action, "duplicate email, case-insensitive")
	assert.Equal(t, ActionConflict, by[ids[7]].Action)
	assert.Equal(t, ActionConflict, by[ids[8]].Action)
	assert.Contains(t, by[ids[8]].Note, "unverified")
	assert.True(t, by[ids[9]].Disabled)
	assert.Equal(t, ActionAlreadyDone, by[ids[10]].Action)
	assert.Equal(t, "usr_EXISTING", by[ids[10]].AuthUserID)
	assert.Equal(t, "bob3", by[ids[11]].Username, "unique within the run too (Bob2 taken above)")

	linked := Plan(users[7:8], in, Options{Passwords: PasswordsNone, LinkExistingVerified: true, Now: now})
	assert.Equal(t, ActionLinkExisting, linked[0].Action)
	assert.Equal(t, "usr_T", linked[0].AuthUserID)

	none := Plan(users[0:1], Inputs{NewID: NewAuthUserID}, Options{Passwords: PasswordsNone, Now: now})
	assert.Equal(t, "", none[0].PasswordHash)

	skip := Plan(users[1:2], Inputs{NewID: NewAuthUserID}, Options{Passwords: PasswordsNone, SkipUnverified: true, Now: now})
	assert.Equal(t, ActionSkip, skip[0].Action)
}

func TestReadExportFormats(t *testing.T) {
	dir := t.TempDir()
	id := uuid.New()
	csvData := "id,email,encrypted_password,email_confirmed_at,raw_user_meta_data,created_at,is_anonymous\n" +
		id.String() + `,a@example.com,$2a$10$x,2024-05-01 12:34:56.789+00,"{""handle"":""ann""}",2024-05-01 12:00:00+00,f` + "\n"
	require.NoError(t, os.WriteFile(filepath.Join(dir, "u.csv"), []byte(csvData), 0o600))
	jsonData := `[{"id":"` + id.String() + `","email":"a@example.com","email_confirmed_at":"2024-05-01T12:34:56.789Z","raw_user_meta_data":{"handle":"ann"},"created_at":"2024-05-01T12:00:00Z"}]`
	require.NoError(t, os.WriteFile(filepath.Join(dir, "u.json"), []byte(jsonData), 0o600))
	jsonl := `{"id":"` + id.String() + `","email":"a@example.com","email_confirmed_at":null,"raw_user_meta_data":{"handle":"ann"}}` + "\n\n"
	require.NoError(t, os.WriteFile(filepath.Join(dir, "u.jsonl"), []byte(jsonl), 0o600))

	for _, name := range []string{"u.csv", "u.json", "u.jsonl"} {
		got, err := ReadExport(filepath.Join(dir, name))
		require.NoError(t, err, name)
		require.Len(t, got, 1, name)
		assert.Equal(t, id, got[0].ID)
		assert.Equal(t, "a@example.com", got[0].Email)
		assert.Equal(t, "ann", got[0].Metadata["handle"])
		assert.False(t, got[0].IsAnonymous)
		if name != "u.jsonl" {
			require.NotNil(t, got[0].EmailConfirmedAt, name)
			assert.Equal(t, 2024, got[0].EmailConfirmedAt.Year())
		} else {
			assert.Nil(t, got[0].EmailConfirmedAt)
		}
	}
	_, err := ReadExport(filepath.Join(dir, "u.txt"))
	assert.Error(t, err)
}
