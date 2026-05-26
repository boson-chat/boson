package user

import (
	"context"
	"errors"
	"testing"

	"github.com/google/uuid"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// stubRepo is a hand-written mock of UserRepositoryImpl driven by lambdas
// stored on the struct. Cleaner than reflection-based mocks for a 3-method interface.
type stubRepo struct {
	findByID     func(ctx context.Context, id uuid.UUID) (*User, error)
	findByHandle func(ctx context.Context, handle string) (*User, error)
	create       func(ctx context.Context, u *User) error
	deleteFn     func(ctx context.Context, id uuid.UUID) error
	createCalls  []*User
	deleteCalls  []uuid.UUID
}

func (s *stubRepo) FindByID(ctx context.Context, id uuid.UUID) (*User, error) {
	return s.findByID(ctx, id)
}
func (s *stubRepo) FindByHandle(ctx context.Context, handle string) (*User, error) {
	return s.findByHandle(ctx, handle)
}
func (s *stubRepo) Create(ctx context.Context, u *User) error {
	s.createCalls = append(s.createCalls, u)
	if s.create != nil {
		return s.create(ctx, u)
	}
	return nil
}
func (s *stubRepo) Delete(ctx context.Context, id uuid.UUID) error {
	s.deleteCalls = append(s.deleteCalls, id)
	if s.deleteFn != nil {
		return s.deleteFn(ctx, id)
	}
	return nil
}

func newNotFoundRepo() *stubRepo {
	return &stubRepo{
		findByID:     func(_ context.Context, _ uuid.UUID) (*User, error) { return nil, ErrNotFound },
		findByHandle: func(_ context.Context, _ string) (*User, error) { return nil, ErrNotFound },
	}
}

func TestUserService_GetByID_Found(t *testing.T) {
	id := uuid.New()
	want := &User{ID: id, Handle: "alice"}
	svc := NewUserService(&stubRepo{
		findByID: func(_ context.Context, gotID uuid.UUID) (*User, error) {
			assert.Equal(t, id, gotID)
			return want, nil
		},
	})

	got, err := svc.GetByID(context.Background(), id)
	require.NoError(t, err)
	assert.Equal(t, want, got)
}

func TestUserService_GetByID_NotFound(t *testing.T) {
	svc := NewUserService(newNotFoundRepo())
	got, err := svc.GetByID(context.Background(), uuid.New())
	assert.Nil(t, got)
	assert.ErrorIs(t, err, ErrNotFound)
}

func TestUserService_Create_Success(t *testing.T) {
	repo := newNotFoundRepo()
	svc := NewUserService(repo)

	id := uuid.New()
	displayName := "Alice"
	got, err := svc.Create(context.Background(), CreateUserInput{
		ID:                  id,
		Handle:              "  alice  ", // trimmed by service
		DisplayName:         &displayName,
		EncryptedUserSecret: []byte("ciphertext"),
	})
	require.NoError(t, err)
	require.Len(t, repo.createCalls, 1)
	assert.Equal(t, "alice", got.Handle)
	assert.Equal(t, id, got.ID)
	assert.True(t, got.IsDiscoverable)
	assert.Equal(t, []byte("ciphertext"), got.EncryptedUserSecret)
}

func TestUserService_Create_HandleTooShort(t *testing.T) {
	svc := NewUserService(newNotFoundRepo())
	_, err := svc.Create(context.Background(), CreateUserInput{
		ID:     uuid.New(),
		Handle: "ab",
	})
	assert.ErrorIs(t, err, ErrHandleInvalid)
}

func TestUserService_Create_AlreadyExists(t *testing.T) {
	id := uuid.New()
	repo := newNotFoundRepo()
	repo.findByID = func(_ context.Context, _ uuid.UUID) (*User, error) {
		return &User{ID: id, Handle: "alice"}, nil
	}
	svc := NewUserService(repo)

	_, err := svc.Create(context.Background(), CreateUserInput{ID: id, Handle: "alice"})
	assert.ErrorIs(t, err, ErrAlreadyExists)
}

func TestUserService_Create_HandleTaken(t *testing.T) {
	repo := newNotFoundRepo()
	repo.findByHandle = func(_ context.Context, h string) (*User, error) {
		return &User{ID: uuid.New(), Handle: h}, nil
	}
	svc := NewUserService(repo)

	_, err := svc.Create(context.Background(), CreateUserInput{
		ID:     uuid.New(),
		Handle: "alice",
	})
	assert.ErrorIs(t, err, ErrHandleTaken)
}

func TestUserService_Create_RepoErrorPropagates(t *testing.T) {
	repo := newNotFoundRepo()
	boom := errors.New("db down")
	repo.create = func(_ context.Context, _ *User) error { return boom }
	svc := NewUserService(repo)

	_, err := svc.Create(context.Background(), CreateUserInput{
		ID:     uuid.New(),
		Handle: "alice",
	})
	assert.ErrorIs(t, err, boom)
}
