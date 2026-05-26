package server

import (
	"context"
	"errors"
	"strings"

	"github.com/google/uuid"
	"github.com/lib/pq"
)

var ErrInvalidInput = errors.New("invalid server input")

type CreateInput struct {
	Hostname    string
	Port        int
	TLS         bool
	Name        string
	Description *string
	Tags        []string
	Languages   []string
	IsNSFW      bool
}

type ServerServiceImpl interface {
	List(ctx context.Context, f ListFilter) ([]*Server, error)
	GetByID(ctx context.Context, id uuid.UUID) (*Server, error)
	Create(ctx context.Context, registeredBy uuid.UUID, in CreateInput) (*Server, error)
}

type ServerService struct {
	Repository ServerRepositoryImpl
}

func NewServerService(repo ServerRepositoryImpl) ServerServiceImpl {
	return &ServerService{Repository: repo}
}

func (s *ServerService) List(ctx context.Context, f ListFilter) ([]*Server, error) {
	return s.Repository.List(ctx, f)
}

func (s *ServerService) GetByID(ctx context.Context, id uuid.UUID) (*Server, error) {
	return s.Repository.FindByID(ctx, id)
}

func (s *ServerService) Create(ctx context.Context, registeredBy uuid.UUID, in CreateInput) (*Server, error) {
	hostname := strings.TrimSpace(in.Hostname)
	name := strings.TrimSpace(in.Name)
	if hostname == "" || name == "" || in.Port <= 0 || in.Port > 65535 {
		return nil, ErrInvalidInput
	}

	tags := in.Tags
	if tags == nil {
		tags = []string{}
	}
	langs := in.Languages
	if langs == nil {
		langs = []string{}
	}
	srv := &Server{
		Hostname:           hostname,
		Port:               in.Port,
		TLS:                in.TLS,
		Name:               name,
		Description:        in.Description,
		Tags:               pq.StringArray(tags),
		Languages:          pq.StringArray(langs),
		IsNSFW:             in.IsNSFW,
		VerificationStatus: "pending",
		HealthStatus:       "unknown",
		RegisteredBy:       &registeredBy,
	}
	if err := s.Repository.Create(ctx, srv); err != nil {
		return nil, err
	}
	return srv, nil
}
