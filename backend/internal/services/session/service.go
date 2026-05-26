package session

import (
	"context"
	"encoding/json"
	"errors"

	"github.com/google/uuid"
)

type ServiceImpl interface {
	Get(ctx context.Context, userID uuid.UUID) (*UserSession, error)
	Put(ctx context.Context, userID uuid.UUID, payload json.RawMessage) (*UserSession, error)
}

type Service struct {
	repo RepositoryImpl
}

func NewService(repo RepositoryImpl) ServiceImpl {
	return &Service{repo: repo}
}

func (s *Service) Get(ctx context.Context, userID uuid.UUID) (*UserSession, error) {
	return s.repo.Get(ctx, userID)
}

// Put stores the session blob verbatim. The payload is validated at the HTTP
// layer (it must parse as a JSON object); beyond that we don't introspect —
// the client owns the schema.
func (s *Service) Put(ctx context.Context, userID uuid.UUID, payload json.RawMessage) (*UserSession, error) {
	if len(payload) == 0 {
		return nil, errors.New("payload is required")
	}
	return s.repo.Upsert(ctx, userID, payload)
}
