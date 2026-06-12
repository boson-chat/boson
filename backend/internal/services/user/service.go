package user

import (
	"context"
	"errors"
	"strings"

	"github.com/google/uuid"
)

var (
	ErrHandleTaken   = errors.New("handle already taken")
	ErrHandleInvalid = errors.New("handle invalid")
	ErrAlreadyExists = errors.New("user already exists")
	ErrInvalidWrap   = errors.New("no secret wrap provided")
)

type CreateUserInput struct {
	ID                          uuid.UUID
	Handle                      string
	DisplayName                 *string
	EncryptedUserSecret         []byte
	EncryptedUserSecretRecovery []byte
}

type UserServiceImpl interface {
	GetByID(ctx context.Context, id uuid.UUID) (*User, error)
	Create(ctx context.Context, in CreateUserInput) (*User, error)
	Delete(ctx context.Context, id uuid.UUID) error
	UpdateHandle(ctx context.Context, id uuid.UUID, newHandle string) (*User, error)
	// UpdateUserSecretWraps replaces the password and/or recovery wrap of the
	// user_secret. A nil slice leaves that wrap untouched — so this serves both
	// "enroll a recovery code later" (recovery only) and "re-wrap after a
	// password reset" (password only). The plaintext user_secret is unchanged;
	// only its server-stored ciphertext wraps are swapped.
	UpdateUserSecretWraps(ctx context.Context, id uuid.UUID, passwordWrap, recoveryWrap []byte) (*User, error)
	// SetAvatarKey stores (or clears, when key is nil) the user's avatar
	// storage key — the R2 object key the avatar service uploaded to.
	SetAvatarKey(ctx context.Context, id uuid.UUID, key *string) (*User, error)
}

type UserService struct {
	Repository UserRepositoryImpl
}

func NewUserService(repo UserRepositoryImpl) UserServiceImpl {
	return &UserService{Repository: repo}
}

func (s *UserService) GetByID(ctx context.Context, id uuid.UUID) (*User, error) {
	return s.Repository.FindByID(ctx, id)
}

func (s *UserService) Create(ctx context.Context, in CreateUserInput) (*User, error) {
	handle := strings.TrimSpace(in.Handle)
	if len(handle) < 3 {
		return nil, ErrHandleInvalid
	}

	if existing, err := s.Repository.FindByID(ctx, in.ID); err == nil && existing != nil {
		return nil, ErrAlreadyExists
	} else if err != nil && !errors.Is(err, ErrNotFound) {
		return nil, err
	}

	if existing, err := s.Repository.FindByHandle(ctx, handle); err == nil && existing != nil {
		return nil, ErrHandleTaken
	} else if err != nil && !errors.Is(err, ErrNotFound) {
		return nil, err
	}

	u := &User{
		ID:                          in.ID,
		Handle:                      handle,
		DisplayName:                 in.DisplayName,
		EncryptedUserSecret:         in.EncryptedUserSecret,
		EncryptedUserSecretRecovery: in.EncryptedUserSecretRecovery,
		IsDiscoverable:              true,
	}
	if err := s.Repository.Create(ctx, u); err != nil {
		return nil, err
	}
	return u, nil
}

// UpdateUserSecretWraps delegates to the repository; nil wraps are left as-is.
// Errors with ErrInvalidWrap if both are nil (nothing to do).
func (s *UserService) UpdateUserSecretWraps(ctx context.Context, id uuid.UUID, passwordWrap, recoveryWrap []byte) (*User, error) {
	if len(passwordWrap) == 0 && len(recoveryWrap) == 0 {
		return nil, ErrInvalidWrap
	}
	return s.Repository.UpdateUserSecretWraps(ctx, id, passwordWrap, recoveryWrap)
}

func (s *UserService) SetAvatarKey(ctx context.Context, id uuid.UUID, key *string) (*User, error) {
	return s.Repository.UpdateAvatarKey(ctx, id, key)
}

func (s *UserService) Delete(ctx context.Context, id uuid.UUID) error {
	return s.Repository.Delete(ctx, id)
}

// UpdateHandle renames the authenticated user. Trims + validates length,
// checks that the new handle is free (case-insensitively, matching the
// users_handle_lower_idx unique semantics), and delegates to the repo
// to do the actual swap in a transaction that also records a
// handle_changes audit row.
func (s *UserService) UpdateHandle(ctx context.Context, id uuid.UUID, newHandle string) (*User, error) {
	handle := strings.TrimSpace(newHandle)
	if len(handle) < 3 {
		return nil, ErrHandleInvalid
	}

	if existing, err := s.Repository.FindByHandle(ctx, handle); err == nil && existing != nil && existing.ID != id {
		return nil, ErrHandleTaken
	} else if err != nil && !errors.Is(err, ErrNotFound) {
		return nil, err
	}

	return s.Repository.UpdateHandle(ctx, id, handle)
}
