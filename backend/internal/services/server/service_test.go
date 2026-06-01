package server

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/boson-chat/boson/backend/internal/services/server/dns"
)

// stubVerifier lets the service-level tests assert how Verify dispatches
// without spinning up a real DNS server (that's the dns package's job —
// see backend/internal/services/server/dns/verify_test.go).
type stubVerifier struct {
	calls  int
	report dns.Report
	err    error
}

func (s *stubVerifier) Verify(_ context.Context, _, _ string, _ dns.Mode) (dns.Report, error) {
	s.calls++
	return s.report, s.err
}

// newServiceForTest wires a ServerService with a fixed clock + stub
// verifier so the timestamps and DNS outcomes in tests are deterministic.
func newServiceForTest(repo *stubRepo, now time.Time, verifier dns.Verifier) *ServerService {
	return &ServerService{
		Repository: repo,
		Verifier:   verifier,
		now:        func() time.Time { return now },
	}
}

type stubRepo struct {
	list        func(ctx context.Context, f ListFilter) ([]*Server, error)
	findByID    func(ctx context.Context, id uuid.UUID) (*Server, error)
	create      func(ctx context.Context, s *Server) error
	update      func(ctx context.Context, s *Server) error
	listByOwner func(ctx context.Context, principalID uuid.UUID) ([]*Server, error)
	createCalls []*Server
	updateCalls []*Server
}

func (s *stubRepo) List(ctx context.Context, f ListFilter) ([]*Server, error) {
	return s.list(ctx, f)
}
func (s *stubRepo) FindByID(ctx context.Context, id uuid.UUID) (*Server, error) {
	return s.findByID(ctx, id)
}
func (s *stubRepo) Create(ctx context.Context, srv *Server) error {
	s.createCalls = append(s.createCalls, srv)
	if s.create != nil {
		return s.create(ctx, srv)
	}
	return nil
}
func (s *stubRepo) Update(ctx context.Context, srv *Server) error {
	s.updateCalls = append(s.updateCalls, srv)
	if s.update != nil {
		return s.update(ctx, srv)
	}
	return nil
}
func (s *stubRepo) ListByOwner(ctx context.Context, principalID uuid.UUID) ([]*Server, error) {
	if s.listByOwner != nil {
		return s.listByOwner(ctx, principalID)
	}
	return nil, nil
}

func TestServerService_List_PassesFilterThrough(t *testing.T) {
	want := []*Server{{Name: "Libera"}}
	var gotFilter ListFilter
	svc := NewServerService(&stubRepo{
		list: func(_ context.Context, f ListFilter) ([]*Server, error) {
			gotFilter = f
			return want, nil
		},
	})

	got, err := svc.List(context.Background(), ListFilter{Query: "foss", Sort: "newest"})
	require.NoError(t, err)
	assert.Equal(t, want, got)
	assert.Equal(t, "foss", gotFilter.Query)
	assert.Equal(t, "newest", gotFilter.Sort)
}

func TestServerService_GetByID_NotFound(t *testing.T) {
	svc := NewServerService(&stubRepo{
		findByID: func(_ context.Context, _ uuid.UUID) (*Server, error) { return nil, ErrNotFound },
	})
	got, err := svc.GetByID(context.Background(), uuid.New())
	assert.Nil(t, got)
	assert.ErrorIs(t, err, ErrNotFound)
}

func TestServerService_Create_Success(t *testing.T) {
	repo := &stubRepo{}
	svc := NewServerService(repo)

	registeredBy := uuid.New()
	desc := "FOSS-focused"
	srv, err := svc.Create(context.Background(), registeredBy, CreateInput{
		Hostname:    "  irc.libera.chat ",
		Port:        6697,
		TLS:         true,
		Name:        " Libera ",
		Description: &desc,
		Tags:        []string{"foss", "tech"},
		Languages:   []string{"en"},
	})
	require.NoError(t, err)
	require.Len(t, repo.createCalls, 1)

	assert.Equal(t, "irc.libera.chat", srv.Hostname, "hostname trimmed")
	assert.Equal(t, "Libera", srv.Name, "name trimmed")
	assert.Equal(t, "pending", srv.VerificationStatus, "starts pending")
	assert.Equal(t, "unknown", srv.HealthStatus, "starts unknown")
	require.NotNil(t, srv.RegisteredBy)
	assert.Equal(t, registeredBy, *srv.RegisteredBy)
}

func TestServerService_Create_InvalidInput(t *testing.T) {
	svc := NewServerService(&stubRepo{})

	cases := map[string]CreateInput{
		"empty hostname": {Hostname: "", Port: 6697, Name: "ok"},
		"empty name":     {Hostname: "irc", Port: 6697, Name: ""},
		"port zero":      {Hostname: "irc", Port: 0, Name: "ok"},
		"port too high":  {Hostname: "irc", Port: 65536, Name: "ok"},
		"negative port":  {Hostname: "irc", Port: -1, Name: "ok"},
	}
	for name, in := range cases {
		t.Run(name, func(t *testing.T) {
			_, err := svc.Create(context.Background(), uuid.New(), in)
			assert.ErrorIs(t, err, ErrInvalidInput)
		})
	}
}

func TestServerService_Create_RepoErrorPropagates(t *testing.T) {
	boom := errors.New("db down")
	svc := NewServerService(&stubRepo{
		create: func(_ context.Context, _ *Server) error { return boom },
	})
	_, err := svc.Create(context.Background(), uuid.New(), CreateInput{
		Hostname: "irc",
		Port:     6697,
		Name:     "Test",
	})
	assert.ErrorIs(t, err, boom)
}

func TestServerService_Create_GeneratesTokenAndIssuedAt(t *testing.T) {
	repo := &stubRepo{}
	now := time.Date(2026, 5, 27, 12, 0, 0, 0, time.UTC)
	svc := newServiceForTest(repo, now, &stubVerifier{})

	srv, err := svc.Create(context.Background(), uuid.New(), CreateInput{
		Hostname: "irc.example.org",
		Port:     6697,
		TLS:      true,
		Name:     "Test",
	})
	require.NoError(t, err)
	require.NotNil(t, srv.VerificationToken)
	assert.NotEmpty(t, *srv.VerificationToken)
	require.NotNil(t, srv.VerificationTokenIssuedAt)
	assert.Equal(t, now, *srv.VerificationTokenIssuedAt)
	assert.Equal(t, "pending", srv.VerificationStatus)
}

func TestServerService_RegenerateToken_RotatesAndRewindsStatus(t *testing.T) {
	owner := uuid.New()
	serverID := uuid.New()
	originalToken := "original-token-value"
	originalIssued := time.Date(2026, 5, 1, 0, 0, 0, 0, time.UTC)
	originalChecked := originalIssued.Add(time.Hour)
	stored := &Server{
		ID:                        serverID,
		Hostname:                  "irc.example.org",
		Port:                      6697,
		RegisteredBy:              &owner,
		VerificationStatus:        "verified", // proves we rewind to pending
		VerificationToken:         &originalToken,
		VerificationTokenIssuedAt: &originalIssued,
		VerificationLastCheckedAt: &originalChecked,
	}
	repo := &stubRepo{
		findByID: func(_ context.Context, _ uuid.UUID) (*Server, error) { return stored, nil },
	}
	now := time.Date(2026, 5, 27, 12, 0, 0, 0, time.UTC)
	svc := newServiceForTest(repo, now, &stubVerifier{})

	out, err := svc.RegenerateToken(context.Background(), serverID, owner)
	require.NoError(t, err)
	require.NotNil(t, out.VerificationToken)
	assert.NotEqual(t, originalToken, *out.VerificationToken)
	require.NotNil(t, out.VerificationTokenIssuedAt)
	assert.Equal(t, now, *out.VerificationTokenIssuedAt)
	assert.Equal(t, "pending", out.VerificationStatus, "should rewind to pending")
	assert.Nil(t, out.VerificationLastCheckedAt, "should clear last-checked")
	require.Len(t, repo.updateCalls, 1)
}

func TestServerService_RegenerateToken_RejectsNonOwner(t *testing.T) {
	owner := uuid.New()
	intruder := uuid.New()
	stored := &Server{RegisteredBy: &owner}
	repo := &stubRepo{
		findByID: func(_ context.Context, _ uuid.UUID) (*Server, error) { return stored, nil },
	}
	svc := newServiceForTest(repo, time.Now(), &stubVerifier{})

	_, err := svc.RegenerateToken(context.Background(), uuid.New(), intruder)
	assert.ErrorIs(t, err, ErrNotOwner)
	assert.Empty(t, repo.updateCalls, "non-owner attempt must not persist anything")
}

func TestServerService_Verify_SuccessTransitionsToVerified(t *testing.T) {
	owner := uuid.New()
	token := "tok"
	issued := time.Date(2026, 5, 27, 10, 0, 0, 0, time.UTC) // 2h ago
	stored := &Server{
		Hostname:                  "irc.example.org",
		RegisteredBy:              &owner,
		VerificationStatus:        "pending",
		VerificationToken:         &token,
		VerificationTokenIssuedAt: &issued,
	}
	repo := &stubRepo{
		findByID: func(_ context.Context, _ uuid.UUID) (*Server, error) { return stored, nil },
	}
	verifier := &stubVerifier{report: dns.Report{Success: true, Results: map[string]dns.Result{}}}
	now := time.Date(2026, 5, 27, 12, 0, 0, 0, time.UTC)
	svc := newServiceForTest(repo, now, verifier)

	srv, report, err := svc.Verify(context.Background(), uuid.New(), owner, dns.ModeStrict)
	require.NoError(t, err)
	assert.True(t, report.Success)
	assert.Equal(t, "verified", srv.VerificationStatus)
	require.NotNil(t, srv.VerificationLastCheckedAt)
	assert.Equal(t, now, *srv.VerificationLastCheckedAt)
}

func TestServerService_Verify_FailKeepsPending(t *testing.T) {
	owner := uuid.New()
	token := "tok"
	issued := time.Date(2026, 5, 27, 10, 0, 0, 0, time.UTC)
	stored := &Server{
		Hostname:                  "irc.example.org",
		RegisteredBy:              &owner,
		VerificationStatus:        "pending",
		VerificationToken:         &token,
		VerificationTokenIssuedAt: &issued,
	}
	repo := &stubRepo{
		findByID: func(_ context.Context, _ uuid.UUID) (*Server, error) { return stored, nil },
	}
	verifier := &stubVerifier{report: dns.Report{Success: false, Results: map[string]dns.Result{}}}
	// Fixed clock pinned to ~1h after issued so the token is fresh.
	// Using time.Now() here was date-fragile — once the wall clock
	// crept past the 72h VerificationTokenTTL, the token expired and
	// the test surfaced ErrTokenExpired instead of testing the
	// fail-keeps-pending path.
	svc := newServiceForTest(repo, issued.Add(time.Hour), verifier)

	srv, report, err := svc.Verify(context.Background(), uuid.New(), owner, dns.ModeStrict)
	require.NoError(t, err)
	assert.False(t, report.Success)
	assert.Equal(t, "pending", srv.VerificationStatus, "failed verify must NOT promote to verified")
	assert.NotNil(t, srv.VerificationLastCheckedAt, "last-checked still bumped on failure")
}

func TestServerService_Verify_FailWhileVerifiedStaysVerified(t *testing.T) {
	// Re-verify path (cron worker, mode=lenient). A soft miss must NOT
	// demote a verified row — the lapsed transition is owned by the
	// worker logic in phase 3, not by Verify itself.
	owner := uuid.New()
	token := "tok"
	issued := time.Date(2026, 5, 1, 0, 0, 0, 0, time.UTC)
	stored := &Server{
		Hostname:                  "irc.example.org",
		RegisteredBy:              &owner,
		VerificationStatus:        "verified",
		VerificationToken:         &token,
		VerificationTokenIssuedAt: &issued,
	}
	repo := &stubRepo{
		findByID: func(_ context.Context, _ uuid.UUID) (*Server, error) { return stored, nil },
	}
	verifier := &stubVerifier{report: dns.Report{Success: false, Results: map[string]dns.Result{}}}
	svc := newServiceForTest(repo, time.Now(), verifier)

	srv, _, err := svc.Verify(context.Background(), uuid.New(), owner, dns.ModeLenient)
	require.NoError(t, err)
	assert.Equal(t, "verified", srv.VerificationStatus, "soft miss must not demote a verified row")
}

func TestServerService_Verify_TokenExpiredAfter72h(t *testing.T) {
	owner := uuid.New()
	token := "tok"
	issued := time.Date(2026, 5, 24, 12, 0, 0, 0, time.UTC) // 73h ago
	stored := &Server{
		Hostname:                  "irc.example.org",
		RegisteredBy:              &owner,
		VerificationStatus:        "pending",
		VerificationToken:         &token,
		VerificationTokenIssuedAt: &issued,
	}
	repo := &stubRepo{
		findByID: func(_ context.Context, _ uuid.UUID) (*Server, error) { return stored, nil },
	}
	verifier := &stubVerifier{}
	now := time.Date(2026, 5, 27, 13, 0, 0, 0, time.UTC) // 73h after issue
	svc := newServiceForTest(repo, now, verifier)

	_, _, err := svc.Verify(context.Background(), uuid.New(), owner, dns.ModeStrict)
	assert.ErrorIs(t, err, ErrTokenExpired)
	assert.Equal(t, 0, verifier.calls, "expired token must short-circuit before hitting DNS")
}

func TestServerService_Verify_RejectsNonOwner(t *testing.T) {
	owner := uuid.New()
	intruder := uuid.New()
	stored := &Server{RegisteredBy: &owner}
	repo := &stubRepo{
		findByID: func(_ context.Context, _ uuid.UUID) (*Server, error) { return stored, nil },
	}
	verifier := &stubVerifier{}
	svc := newServiceForTest(repo, time.Now(), verifier)

	_, _, err := svc.Verify(context.Background(), uuid.New(), intruder, dns.ModeStrict)
	assert.ErrorIs(t, err, ErrNotOwner)
	assert.Equal(t, 0, verifier.calls, "non-owner must not be allowed to trigger DNS lookups")
}

func TestServerService_ListByOwner_PassesThrough(t *testing.T) {
	owner := uuid.New()
	want := []*Server{{Name: "A"}, {Name: "B"}}
	repo := &stubRepo{
		listByOwner: func(_ context.Context, p uuid.UUID) ([]*Server, error) {
			assert.Equal(t, owner, p)
			return want, nil
		},
	}
	svc := newServiceForTest(repo, time.Now(), &stubVerifier{})

	got, err := svc.ListByOwner(context.Background(), owner)
	require.NoError(t, err)
	assert.Equal(t, want, got)
}

func TestServerService_UpdateProfile_OwnerOnlyUpdatesProvidedFields(t *testing.T) {
	// Pointers in UpdateProfileInput distinguish "leave alone" (nil)
	// from "set to zero" (non-nil pointer to empty value). This test
	// exercises both halves: name + tags are mutated, description is
	// left alone, languages is explicitly cleared.
	owner := uuid.New()
	originalDesc := "old description"
	stored := &Server{
		ID:           uuid.New(),
		RegisteredBy: &owner,
		Name:         "Old Name",
		Description:  &originalDesc,
		Tags:         []string{"old-tag"},
		Languages:    []string{"en"},
		IsNSFW:       false,
	}
	repo := &stubRepo{
		findByID: func(_ context.Context, _ uuid.UUID) (*Server, error) { return stored, nil },
	}
	svc := newServiceForTest(repo, time.Now(), &stubVerifier{})

	newName := "New Name"
	newTags := []string{"foo", "bar"}
	emptyLangs := []string{}
	out, err := svc.UpdateProfile(context.Background(), stored.ID, owner, UpdateProfileInput{
		Name:      &newName,
		Tags:      &newTags,
		Languages: &emptyLangs,
		// Description omitted → left alone.
	})
	require.NoError(t, err)
	assert.Equal(t, "New Name", out.Name)
	assert.Equal(t, []string{"foo", "bar"}, []string(out.Tags))
	assert.Empty(t, []string(out.Languages))
	require.NotNil(t, out.Description)
	assert.Equal(t, "old description", *out.Description)
	require.Len(t, repo.updateCalls, 1)
}

func TestServerService_UpdateProfile_RejectsNonOwner(t *testing.T) {
	owner := uuid.New()
	intruder := uuid.New()
	stored := &Server{RegisteredBy: &owner}
	repo := &stubRepo{
		findByID: func(_ context.Context, _ uuid.UUID) (*Server, error) { return stored, nil },
	}
	svc := newServiceForTest(repo, time.Now(), &stubVerifier{})

	name := "Hacker"
	_, err := svc.UpdateProfile(context.Background(), uuid.New(), intruder, UpdateProfileInput{Name: &name})
	assert.ErrorIs(t, err, ErrNotOwner)
	assert.Empty(t, repo.updateCalls)
}

func TestServerService_UpdateProfile_RejectsEmptyName(t *testing.T) {
	// Trimming an all-whitespace name is the same as deleting it; the
	// row can't be displayed without a name so we refuse the update.
	owner := uuid.New()
	stored := &Server{RegisteredBy: &owner, Name: "Old"}
	repo := &stubRepo{
		findByID: func(_ context.Context, _ uuid.UUID) (*Server, error) { return stored, nil },
	}
	svc := newServiceForTest(repo, time.Now(), &stubVerifier{})

	empty := "   "
	_, err := svc.UpdateProfile(context.Background(), uuid.New(), owner, UpdateProfileInput{Name: &empty})
	assert.ErrorIs(t, err, ErrInvalidInput)
	assert.Empty(t, repo.updateCalls)
}

func TestServerService_UpdateProfile_EmptyDescriptionClears(t *testing.T) {
	owner := uuid.New()
	desc := "non-empty"
	stored := &Server{RegisteredBy: &owner, Name: "Test", Description: &desc}
	repo := &stubRepo{
		findByID: func(_ context.Context, _ uuid.UUID) (*Server, error) { return stored, nil },
	}
	svc := newServiceForTest(repo, time.Now(), &stubVerifier{})

	empty := ""
	out, err := svc.UpdateProfile(context.Background(), uuid.New(), owner, UpdateProfileInput{Description: &empty})
	require.NoError(t, err)
	assert.Nil(t, out.Description, "empty description must clear, not store ''")
}

func TestServer_ToOwnerView_IncludesTokenOnlyForPending(t *testing.T) {
	token := "tok"
	issued := time.Now()
	pending := &Server{
		VerificationStatus:        "pending",
		VerificationToken:         &token,
		VerificationTokenIssuedAt: &issued,
	}
	view := pending.ToOwnerView()
	withToken, ok := view.(ServerWithToken)
	require.True(t, ok, "pending row should marshal as ServerWithToken; got %T", view)
	assert.Equal(t, token, withToken.VerificationToken)

	verified := &Server{
		VerificationStatus:        "verified",
		VerificationToken:         &token,
		VerificationTokenIssuedAt: &issued,
	}
	view2 := verified.ToOwnerView()
	_, isServer := view2.(*Server)
	assert.True(t, isServer, "verified row should fall back to plain *Server (token redacted)")
}
