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
// stored on the struct. Cleaner than reflection-based mocks.
type stubRepo struct {
	findByID         func(ctx context.Context, id uuid.UUID) (*User, error)
	findByHandle     func(ctx context.Context, handle string) (*User, error)
	create           func(ctx context.Context, u *User) error
	deleteFn         func(ctx context.Context, id uuid.UUID) error
	updateHandle     func(ctx context.Context, id uuid.UUID, newHandle string) (*User, error)
	updateWraps      func(ctx context.Context, id uuid.UUID, passwordWrap, recoveryWrap []byte) (*User, error)
	createCalls      []*User
	deleteCalls      []uuid.UUID
	updateHandleCalls []stubRepoUpdateHandleCall
}

type stubRepoUpdateHandleCall struct {
	ID        uuid.UUID
	NewHandle string
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
func (s *stubRepo) UpdateHandle(ctx context.Context, id uuid.UUID, newHandle string) (*User, error) {
	s.updateHandleCalls = append(s.updateHandleCalls, stubRepoUpdateHandleCall{ID: id, NewHandle: newHandle})
	if s.updateHandle != nil {
		return s.updateHandle(ctx, id, newHandle)
	}
	return nil, nil
}

func (s *stubRepo) UpdateUserSecretWraps(ctx context.Context, id uuid.UUID, passwordWrap, recoveryWrap []byte) (*User, error) {
	if s.updateWraps != nil {
		return s.updateWraps(ctx, id, passwordWrap, recoveryWrap)
	}
	return nil, nil
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

func TestUserService_UpdateHandle_Success(t *testing.T) {
	id := uuid.New()
	want := &User{ID: id, Handle: "alice-new"}
	repo := newNotFoundRepo()
	repo.updateHandle = func(_ context.Context, gotID uuid.UUID, h string) (*User, error) {
		assert.Equal(t, id, gotID)
		assert.Equal(t, "alice-new", h)
		return want, nil
	}
	svc := NewUserService(repo)

	got, err := svc.UpdateHandle(context.Background(), id, "  alice-new  ")
	require.NoError(t, err)
	assert.Equal(t, want, got)
	require.Len(t, repo.updateHandleCalls, 1)
	assert.Equal(t, "alice-new", repo.updateHandleCalls[0].NewHandle, "service must trim before delegating")
}

func TestUserService_UpdateHandle_TooShort(t *testing.T) {
	svc := NewUserService(newNotFoundRepo())
	_, err := svc.UpdateHandle(context.Background(), uuid.New(), "ab")
	assert.ErrorIs(t, err, ErrHandleInvalid)
}

func TestUserService_UpdateHandle_TrimsToTooShort(t *testing.T) {
	svc := NewUserService(newNotFoundRepo())
	_, err := svc.UpdateHandle(context.Background(), uuid.New(), "   ")
	assert.ErrorIs(t, err, ErrHandleInvalid)
}

func TestUserService_UpdateHandle_HandleTakenByOther(t *testing.T) {
	otherID := uuid.New()
	repo := newNotFoundRepo()
	repo.findByHandle = func(_ context.Context, h string) (*User, error) {
		return &User{ID: otherID, Handle: h}, nil
	}
	svc := NewUserService(repo)

	_, err := svc.UpdateHandle(context.Background(), uuid.New(), "alice")
	assert.ErrorIs(t, err, ErrHandleTaken)
}

// Re-claiming the handle the user already owns is a no-op rename — the
// service must let it through (not flag it as ErrHandleTaken) so the
// repo's transactional path returns the unchanged row.
func TestUserService_UpdateHandle_SameUserOwnsHandle(t *testing.T) {
	id := uuid.New()
	want := &User{ID: id, Handle: "alice"}
	repo := newNotFoundRepo()
	repo.findByHandle = func(_ context.Context, h string) (*User, error) {
		return &User{ID: id, Handle: h}, nil
	}
	repo.updateHandle = func(_ context.Context, _ uuid.UUID, _ string) (*User, error) {
		return want, nil
	}
	svc := NewUserService(repo)

	got, err := svc.UpdateHandle(context.Background(), id, "alice")
	require.NoError(t, err)
	assert.Equal(t, want, got)
}

func TestUserService_UpdateUserSecretWraps_RejectsEmpty(t *testing.T) {
	svc := NewUserService(newNotFoundRepo())
	_, err := svc.UpdateUserSecretWraps(context.Background(), uuid.New(), nil, nil)
	assert.ErrorIs(t, err, ErrInvalidWrap)
}

func TestUserService_UpdateUserSecretWraps_Delegates(t *testing.T) {
	id := uuid.New()
	want := &User{ID: id, Handle: "alice"}
	repo := newNotFoundRepo()
	repo.updateWraps = func(_ context.Context, gotID uuid.UUID, pw, rec []byte) (*User, error) {
		assert.Equal(t, id, gotID)
		assert.Nil(t, pw)
		assert.Equal(t, []byte("rec"), rec)
		return want, nil
	}
	svc := NewUserService(repo)

	got, err := svc.UpdateUserSecretWraps(context.Background(), id, nil, []byte("rec"))
	require.NoError(t, err)
	assert.Equal(t, want, got)
}

func TestUserService_UpdateHandle_NotFound(t *testing.T) {
	repo := newNotFoundRepo()
	repo.updateHandle = func(_ context.Context, _ uuid.UUID, _ string) (*User, error) {
		return nil, ErrNotFound
	}
	svc := NewUserService(repo)
	_, err := svc.UpdateHandle(context.Background(), uuid.New(), "alice")
	assert.ErrorIs(t, err, ErrNotFound)
}

func TestUserService_UpdateHandle_FindByHandleErrorPropagates(t *testing.T) {
	boom := errors.New("db down")
	repo := newNotFoundRepo()
	repo.findByHandle = func(_ context.Context, _ string) (*User, error) { return nil, boom }
	svc := NewUserService(repo)

	_, err := svc.UpdateHandle(context.Background(), uuid.New(), "alice")
	assert.ErrorIs(t, err, boom)
}
