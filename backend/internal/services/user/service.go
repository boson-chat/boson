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
)

type CreateUserInput struct {
	ID                  uuid.UUID
	Handle              string
	DisplayName         *string
	EncryptedUserSecret []byte
}

type UserServiceImpl interface {
	GetByID(ctx context.Context, id uuid.UUID) (*User, error)
	Create(ctx context.Context, in CreateUserInput) (*User, error)
	Delete(ctx context.Context, id uuid.UUID) error
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
		ID:                  in.ID,
		Handle:              handle,
		DisplayName:         in.DisplayName,
		EncryptedUserSecret: in.EncryptedUserSecret,
		IsDiscoverable:      true,
	}
	if err := s.Repository.Create(ctx, u); err != nil {
		return nil, err
	}
	return u, nil
}

func (s *UserService) Delete(ctx context.Context, id uuid.UUID) error {
	return s.Repository.Delete(ctx, id)
}
