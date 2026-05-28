package server

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/lib/pq"

	"github.com/boson-chat/boson/backend/internal/services/server/dns"
)

var (
	ErrInvalidInput  = errors.New("invalid server input")
	ErrNotOwner      = errors.New("caller does not own this server")
	ErrTokenExpired  = errors.New("verification token has expired")
	ErrMissingToken  = errors.New("server has no verification token to check")
)

// VerificationTokenTTL is how long an unverified token stays usable
// after issuance. 72h gives operators a generous window for DNS
// propagation while limiting the blast radius of a leaked token.
// After expiry, the row stays (status: pending) but Verify() refuses
// to operate — the operator must regenerate before trying again.
const VerificationTokenTTL = 72 * time.Hour

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
	// ListByOwner returns every server the principal registered, any
	// status. The HTTP handler marshals each row through ToOwnerView so
	// the verification_token is included only on pending entries.
	ListByOwner(ctx context.Context, principalID uuid.UUID) ([]*Server, error)
	// RegenerateToken mints a fresh verification_token + issued_at on the
	// owner's row and rewinds status to pending. Used both for "I lost
	// the original" and for the post-72h-expiry restart path.
	RegenerateToken(ctx context.Context, serverID, principalID uuid.UUID) (*Server, error)
	// Verify runs the DNS TXT check and persists the result. Mode is
	// ModeStrict for first-ever verifies (status currently pending) and
	// ModeLenient for re-verify runs from the cron worker. The Report
	// is returned verbatim so the HTTP layer can surface the per-resolver
	// matrix to the client UI.
	Verify(ctx context.Context, serverID, principalID uuid.UUID, mode dns.Mode) (*Server, dns.Report, error)
	// UpdateProfile mutates the human-facing fields of a server row —
	// display name, description, tags, languages, NSFW flag — without
	// touching the immutable identity fields (hostname, port, TLS,
	// verification status). Owner-only. Identity changes would require
	// re-verification so we refuse them here; the caller's path is
	// "register a new row" + "delete the old one" if they really need
	// to move host:port. Returns the updated server.
	UpdateProfile(ctx context.Context, serverID, principalID uuid.UUID, in UpdateProfileInput) (*Server, error)
}

// UpdateProfileInput carries the optional fields the owner can change.
// Pointers distinguish "leave this field alone" (nil) from "set this
// to its zero value" (non-nil pointer to empty string / empty slice).
// Slices for tags + languages REPLACE rather than merge — partial
// updates would invite duplicate-tag edge cases we don't want to
// design around.
type UpdateProfileInput struct {
	Name        *string
	Description *string
	Tags        *[]string
	Languages   *[]string
	IsNSFW      *bool
}

type ServerService struct {
	Repository ServerRepositoryImpl
	Verifier   dns.Verifier
	// now returns the current time. Tests override with a frozen clock
	// so they can drive expiry / lapsed-status logic deterministically.
	now func() time.Time
}

// NewServerService builds the production service wired to the supplied
// repository + the default DNS verifier. Callers that want a custom
// verifier (tests, dev tools) should set s.Verifier after construction.
func NewServerService(repo ServerRepositoryImpl) ServerServiceImpl {
	return &ServerService{
		Repository: repo,
		Verifier:   dns.NewVerifier(),
		now:        time.Now,
	}
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

	token, err := generateToken()
	if err != nil {
		return nil, fmt.Errorf("generate verification token: %w", err)
	}
	issuedAt := s.now()

	srv := &Server{
		Hostname:                  hostname,
		Port:                      in.Port,
		TLS:                       in.TLS,
		Name:                      name,
		Description:               in.Description,
		Tags:                      pq.StringArray(tags),
		Languages:                 pq.StringArray(langs),
		IsNSFW:                    in.IsNSFW,
		VerificationStatus:        "pending",
		VerificationToken:         &token,
		VerificationTokenIssuedAt: &issuedAt,
		HealthStatus:              "unknown",
		RegisteredBy:              &registeredBy,
	}
	if err := s.Repository.Create(ctx, srv); err != nil {
		return nil, err
	}
	return srv, nil
}

func (s *ServerService) ListByOwner(ctx context.Context, principalID uuid.UUID) ([]*Server, error) {
	return s.Repository.ListByOwner(ctx, principalID)
}

func (s *ServerService) RegenerateToken(ctx context.Context, serverID, principalID uuid.UUID) (*Server, error) {
	srv, err := s.Repository.FindByID(ctx, serverID)
	if err != nil {
		return nil, err
	}
	if srv.RegisteredBy == nil || *srv.RegisteredBy != principalID {
		return nil, ErrNotOwner
	}
	token, err := generateToken()
	if err != nil {
		return nil, fmt.Errorf("generate verification token: %w", err)
	}
	issuedAt := s.now()
	srv.VerificationToken = &token
	srv.VerificationTokenIssuedAt = &issuedAt
	srv.VerificationStatus = "pending"
	// Clear the last-checked timestamp so the UI doesn't show stale
	// "verified at <timestamp>" copy after a regenerate.
	srv.VerificationLastCheckedAt = nil
	if err := s.Repository.Update(ctx, srv); err != nil {
		return nil, err
	}
	return srv, nil
}

func (s *ServerService) UpdateProfile(ctx context.Context, serverID, principalID uuid.UUID, in UpdateProfileInput) (*Server, error) {
	srv, err := s.Repository.FindByID(ctx, serverID)
	if err != nil {
		return nil, err
	}
	if srv.RegisteredBy == nil || *srv.RegisteredBy != principalID {
		return nil, ErrNotOwner
	}

	if in.Name != nil {
		name := strings.TrimSpace(*in.Name)
		if name == "" {
			return nil, ErrInvalidInput
		}
		srv.Name = name
	}
	if in.Description != nil {
		// Empty string clears the field; nil leaves it alone. Pointer
		// dance is the same as the existing CreateInput.Description.
		trimmed := strings.TrimSpace(*in.Description)
		if trimmed == "" {
			srv.Description = nil
		} else {
			srv.Description = &trimmed
		}
	}
	if in.Tags != nil {
		srv.Tags = pq.StringArray(*in.Tags)
	}
	if in.Languages != nil {
		srv.Languages = pq.StringArray(*in.Languages)
	}
	if in.IsNSFW != nil {
		srv.IsNSFW = *in.IsNSFW
	}

	if err := s.Repository.Update(ctx, srv); err != nil {
		return nil, err
	}
	return srv, nil
}

func (s *ServerService) Verify(ctx context.Context, serverID, principalID uuid.UUID, mode dns.Mode) (*Server, dns.Report, error) {
	srv, err := s.Repository.FindByID(ctx, serverID)
	if err != nil {
		return nil, dns.Report{}, err
	}
	if srv.RegisteredBy == nil || *srv.RegisteredBy != principalID {
		return nil, dns.Report{}, ErrNotOwner
	}
	if srv.VerificationToken == nil || *srv.VerificationToken == "" {
		return nil, dns.Report{}, ErrMissingToken
	}
	// 72h TTL on the token. Only enforced for rows still pending — if
	// the cron worker is re-verifying a previously-verified row, we
	// don't care when the original token was issued.
	if srv.VerificationStatus == "pending" && srv.VerificationTokenIssuedAt != nil {
		if s.now().Sub(*srv.VerificationTokenIssuedAt) > VerificationTokenTTL {
			return srv, dns.Report{}, ErrTokenExpired
		}
	}

	report, err := s.Verifier.Verify(ctx, srv.Hostname, *srv.VerificationToken, mode)
	if err != nil {
		return srv, dns.Report{}, err
	}

	now := s.now()
	srv.VerificationLastCheckedAt = &now

	if report.Success {
		srv.VerificationStatus = "verified"
	} else if srv.VerificationStatus == "verified" {
		// Re-verify path failed soft — first miss doesn't change status.
		// The cron worker decides whether to escalate to "lapsed" based
		// on the time since the last successful match (see phase 3).
	}

	if err := s.Repository.Update(ctx, srv); err != nil {
		return srv, report, err
	}
	return srv, report, nil
}

// generateToken produces a 32-byte cryptographically random value
// encoded as URL-safe base64 with no padding (43 characters). The
// encoding matches what we ask operators to drop into the TXT record
// body so the resolver-side comparison is byte-exact.
func generateToken() (string, error) {
	buf := make([]byte, 32)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(buf), nil
}
