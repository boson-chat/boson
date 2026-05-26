package handlers

import (
	"context"

	"github.com/boson-chat/boson/backend/internal/services/server"
	"github.com/boson-chat/boson/backend/internal/services/user"

	"github.com/google/uuid"
)

// stubUserService is a hand-written mock of user.UserServiceImpl.
type stubUserService struct {
	getByID    func(ctx context.Context, id uuid.UUID) (*user.User, error)
	create     func(ctx context.Context, in user.CreateUserInput) (*user.User, error)
	deleteFn   func(ctx context.Context, id uuid.UUID) error
	createArgs []user.CreateUserInput
	deleteArgs []uuid.UUID
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

// stubServerService is a hand-written mock of server.ServerServiceImpl.
type stubServerService struct {
	list       func(ctx context.Context, f server.ListFilter) ([]*server.Server, error)
	getByID    func(ctx context.Context, id uuid.UUID) (*server.Server, error)
	create     func(ctx context.Context, registeredBy uuid.UUID, in server.CreateInput) (*server.Server, error)
	createArgs []server.CreateInput
	listArgs   []server.ListFilter
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
