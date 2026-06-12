package handlers

import (
	"context"

	"github.com/boson-chat/boson/backend/internal/services/server"
	"github.com/boson-chat/boson/backend/internal/services/server/dns"
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

// stubServerService is a hand-written mock of server.ServerServiceImpl.
type stubServerService struct {
	list            func(ctx context.Context, f server.ListFilter) ([]*server.Server, error)
	getByID         func(ctx context.Context, id uuid.UUID) (*server.Server, error)
	create          func(ctx context.Context, registeredBy uuid.UUID, in server.CreateInput) (*server.Server, error)
	listByOwner     func(ctx context.Context, principalID uuid.UUID) ([]*server.Server, error)
	regenerateToken func(ctx context.Context, serverID, principalID uuid.UUID) (*server.Server, error)
	verify          func(ctx context.Context, serverID, principalID uuid.UUID, mode dns.Mode) (*server.Server, dns.Report, error)
	updateProfile   func(ctx context.Context, serverID, principalID uuid.UUID, in server.UpdateProfileInput) (*server.Server, error)
	setImageKey     func(ctx context.Context, serverID, principalID uuid.UUID, which string, key *string) (*server.Server, error)
	createArgs      []server.CreateInput
	listArgs        []server.ListFilter
}

func (s *stubServerService) List(ctx context.Context, f server.ListFilter) ([]*server.Server, error) {
	s.listArgs = append(s.listArgs, f)
	return s.list(ctx, f)
}
func (s *stubServerService) GetByID(ctx context.Context, id uuid.UUID) (*server.Server, error) {
	return s.getByID(ctx, id)
}
func (s *stubServerService) Create(ctx context.Context, registeredBy uuid.UUID, in server.CreateInput) (*server.Server, error) {
	s.createArgs = append(s.createArgs, in)
	return s.create(ctx, registeredBy, in)
}
func (s *stubServerService) ListByOwner(ctx context.Context, principalID uuid.UUID) ([]*server.Server, error) {
	if s.listByOwner != nil {
		return s.listByOwner(ctx, principalID)
	}
	return nil, nil
}
func (s *stubServerService) RegenerateToken(ctx context.Context, serverID, principalID uuid.UUID) (*server.Server, error) {
	if s.regenerateToken != nil {
		return s.regenerateToken(ctx, serverID, principalID)
	}
	return nil, nil
}
func (s *stubServerService) Verify(ctx context.Context, serverID, principalID uuid.UUID, mode dns.Mode) (*server.Server, dns.Report, error) {
	if s.verify != nil {
		return s.verify(ctx, serverID, principalID, mode)
	}
	return nil, dns.Report{}, nil
}
func (s *stubServerService) UpdateProfile(ctx context.Context, serverID, principalID uuid.UUID, in server.UpdateProfileInput) (*server.Server, error) {
	if s.updateProfile != nil {
		return s.updateProfile(ctx, serverID, principalID, in)
	}
	return nil, nil
}
func (s *stubServerService) SetImageKey(ctx context.Context, serverID, principalID uuid.UUID, which string, key *string) (*server.Server, error) {
	if s.setImageKey != nil {
		return s.setImageKey(ctx, serverID, principalID, which, key)
	}
	return &server.Server{ID: serverID}, nil
}
