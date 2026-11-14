package handlers

import (
	"context"

	"github.com/boson-chat/boson/backend/internal/services/user"

	"github.com/google/uuid"
)

// stubUserService is a hand-written mock of user.UserServiceImpl.
type stubUserService struct {
	getByID          func(ctx context.Context, id uuid.UUID) (*user.User, error)
	create           func(ctx context.Context, in user.CreateUserInput) (*user.User, error)
	deleteFn         func(ctx context.Context, id uuid.UUID) error
	updateHandle     func(ctx context.Context, id uuid.UUID, newHandle string) (*user.User, error)
	updateWraps      func(ctx context.Context, id uuid.UUID, passwordWrap, recoveryWrap []byte) (*user.User, error)
	setAvatarKey     func(ctx context.Context, id uuid.UUID, key *string) (*user.User, error)
	createArgs       []user.CreateUserInput
	deleteArgs       []uuid.UUID
	updateHandleArgs []updateHandleCall
	updateWrapsArgs  []updateWrapsCall
}

type updateWrapsCall struct {
	ID           uuid.UUID
	PasswordWrap []byte
	RecoveryWrap []byte
}

type updateHandleCall struct {
	ID        uuid.UUID
	NewHandle string
}

func (s *stubUserService) GetByID(ctx context.Context, id uuid.UUID) (*user.User, error) {
	return s.getByID(ctx, id)
}
func (s *stubUserService) Create(ctx context.Context, in user.CreateUserInput) (*user.User, error) {
	s.createArgs = append(s.createArgs, in)
	return s.create(ctx, in)
}
func (s *stubUserService) Delete(ctx context.Context, id uuid.UUID) error {
	s.deleteArgs = append(s.deleteArgs, id)
	if s.deleteFn != nil {
		return s.deleteFn(ctx, id)
	}
	return nil
}
func (s *stubUserService) UpdateHandle(ctx context.Context, id uuid.UUID, newHandle string) (*user.User, error) {
	s.updateHandleArgs = append(s.updateHandleArgs, updateHandleCall{ID: id, NewHandle: newHandle})
	if s.updateHandle != nil {
		return s.updateHandle(ctx, id, newHandle)
	}
	return nil, nil
}
func (s *stubUserService) UpdateUserSecretWraps(ctx context.Context, id uuid.UUID, passwordWrap, recoveryWrap []byte) (*user.User, error) {
	s.updateWrapsArgs = append(s.updateWrapsArgs, updateWrapsCall{ID: id, PasswordWrap: passwordWrap, RecoveryWrap: recoveryWrap})
	if s.updateWraps != nil {
		return s.updateWraps(ctx, id, passwordWrap, recoveryWrap)
	}
	return nil, nil
}
func (s *stubUserService) SetAvatarKey(ctx context.Context, id uuid.UUID, key *string) (*user.User, error) {
	if s.setAvatarKey != nil {
		return s.setAvatarKey(ctx, id, key)
	}
	return &user.User{ID: id, AvatarStorageKey: key}, nil
}
