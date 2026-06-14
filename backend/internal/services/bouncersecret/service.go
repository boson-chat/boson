package bouncersecret

import (
	"context"
	"errors"

	"github.com/google/uuid"
)

var ErrEmptyCiphertext = errors.New("ciphertext is required")

type ServiceImpl interface {
	Get(ctx context.Context, userID uuid.UUID) (*BouncerSecret, error)
	Put(ctx context.Context, userID uuid.UUID, ciphertext []byte) (*BouncerSecret, error)
	Delete(ctx context.Context, userID uuid.UUID) error
}

type Service struct {
	repo RepositoryImpl
}

func NewService(repo RepositoryImpl) ServiceImpl {
	return &Service{repo: repo}
}

func (s *Service) Get(ctx context.Context, userID uuid.UUID) (*BouncerSecret, error) {
	return s.repo.Get(ctx, userID)
}

// Put validates and stores the opaque ciphertext for the user. The server
// never inspects the plaintext — it can't, it's E2E encrypted.
func (s *Service) Put(ctx context.Context, userID uuid.UUID, ciphertext []byte) (*BouncerSecret, error) {
	if len(ciphertext) == 0 {
		return nil, ErrEmptyCiphertext
	}
	return s.repo.Upsert(ctx, userID, ciphertext)
}

func (s *Service) Delete(ctx context.Context, userID uuid.UUID) error {
	return s.repo.Delete(ctx, userID)
}
