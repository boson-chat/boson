package server

import (
	"context"
	"errors"
	"testing"

	"github.com/google/uuid"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

type stubRepo struct {
	list        func(ctx context.Context, f ListFilter) ([]*Server, error)
	findByID    func(ctx context.Context, id uuid.UUID) (*Server, error)
	create      func(ctx context.Context, s *Server) error
	createCalls []*Server
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
