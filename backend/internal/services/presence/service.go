package presence

import (
	"context"
	"errors"
	"strings"

	"github.com/google/uuid"
)

var (
	ErrInvalidNetwork = errors.New("network is required")
	ErrInvalidNick    = errors.New("nick is required")
)

type ServiceImpl interface {
	// Publish stores the caller's current identity on a network.
	Publish(ctx context.Context, userID uuid.UUID, network, nick, host, account string) (*MemberPresence, error)
	// Lookup resolves which observed users are Boson members.
	Lookup(ctx context.Context, network string, items []LookupItem) ([]LookupMatch, error)
}

type Service struct {
	repo RepositoryImpl
}

func NewService(repo RepositoryImpl) ServiceImpl {
	return &Service{repo: repo}
}

func (s *Service) Publish(ctx context.Context, userID uuid.UUID, network, nick, host, account string) (*MemberPresence, error) {
	network = strings.TrimSpace(network)
	nick = strings.TrimSpace(nick)
	if network == "" {
		return nil, ErrInvalidNetwork
	}
	if nick == "" {
		return nil, ErrInvalidNick
	}
	return s.repo.Upsert(ctx, userID, network, nick, strings.TrimSpace(host), strings.TrimSpace(account))
}

func (s *Service) Lookup(ctx context.Context, network string, items []LookupItem) ([]LookupMatch, error) {
	network = strings.TrimSpace(network)
	if network == "" {
		return nil, ErrInvalidNetwork
	}
	return s.repo.Lookup(ctx, network, items)
}
