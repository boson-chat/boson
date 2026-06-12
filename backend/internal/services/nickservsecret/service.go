package nickservsecret

import (
	"context"
	"errors"
	"strings"

	"github.com/google/uuid"
)

var (
	ErrInvalidServerID = errors.New("server_id is required")
	ErrEmptyCiphertext = errors.New("ciphertext is required")
)

type ServiceImpl interface {
	List(ctx context.Context, userID uuid.UUID) ([]NickservSecret, error)
	Put(ctx context.Context, userID uuid.UUID, serverID string, ciphertext []byte) (*NickservSecret, error)
	Delete(ctx context.Context, userID uuid.UUID, serverID string) error
}

type Service struct {
	repo RepositoryImpl
}

func NewService(repo RepositoryImpl) ServiceImpl {
	return &Service{repo: repo}
}

func (s *Service) List(ctx context.Context, userID uuid.UUID) ([]NickservSecret, error) {
	return s.repo.List(ctx, userID)
}

// Put validates and stores the opaque ciphertext for (user, server). The
// server never inspects the plaintext — it can't, it's E2E encrypted.
func (s *Service) Put(ctx context.Context, userID uuid.UUID, serverID string, ciphertext []byte) (*NickservSecret, error) {
	if strings.TrimSpace(serverID) == "" {
		return nil, ErrInvalidServerID
	}
	if len(ciphertext) == 0 {
		return nil, ErrEmptyCiphertext
	}
	return s.repo.Upsert(ctx, userID, serverID, ciphertext)
}

func (s *Service) Delete(ctx context.Context, userID uuid.UUID, serverID string) error {
	if strings.TrimSpace(serverID) == "" {
		return ErrInvalidServerID
	}
	return s.repo.Delete(ctx, userID, serverID)
}
