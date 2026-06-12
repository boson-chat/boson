package nickclaim

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
)

var (
	// ErrRateLimited is returned when the user has minted more
	// claims than the per-window budget. The handler maps this to
	// HTTP 429.
	ErrRateLimited = errors.New("nick claim rate limit exceeded")
)

// Config is the subset of app config the service needs. Keeps
// service-layer code independent of the larger AppConfig struct
// (test seam + boundary discipline).
type Config struct {
	// EmailDomain is the right-hand-side of the recipient address.
	// Defaults to "boson.chat" in production; tests override.
	EmailDomain string
	// RateLimitPerHour caps how many claims a single user can mint
	// in a rolling 60-minute window. Anything > this returns
	// ErrRateLimited.
	RateLimitPerHour int
}

type ServiceImpl interface {
	// CreateClaim mints a pending row and returns it. Enforces the
	// per-user rate limit.
	CreateClaim(ctx context.Context, userID uuid.UUID, serverID, accountNick string) (*NickClaim, error)

	// GetClaim returns the claim if it belongs to userID. Returns
	// ErrNotFound otherwise.
	GetClaim(ctx context.Context, id, userID uuid.UUID) (*NickClaim, error)

	// ConsumeIfCaptured atomically flips status from captured →
	// consumed if applicable. Idempotent — calling on an already-
	// consumed row returns the stored code without re-flipping.
	ConsumeIfCaptured(ctx context.Context, id, userID uuid.UUID) (*NickClaim, error)

	// EmailFor returns the recipient address the IRC NickServ
	// should email. Format: `reg+<userid>-<short_token>@<domain>`.
	EmailFor(c *NickClaim) string
}

type Service struct {
	Repository RepositoryImpl
	Config     Config
	now        func() time.Time
}

func NewService(repo RepositoryImpl, cfg Config) ServiceImpl {
	if cfg.EmailDomain == "" {
		cfg.EmailDomain = "boson.chat"
	}
	if cfg.RateLimitPerHour <= 0 {
		cfg.RateLimitPerHour = 5
	}
	return &Service{Repository: repo, Config: cfg, now: time.Now}
}

// NewServiceWithClock — test seam.
func NewServiceWithClock(repo RepositoryImpl, cfg Config, now func() time.Time) ServiceImpl {
	s := NewService(repo, cfg).(*Service)
	s.now = now
	return s
}

func (s *Service) CreateClaim(ctx context.Context, userID uuid.UUID, serverID, accountNick string) (*NickClaim, error) {
	serverID = strings.TrimSpace(serverID)
	accountNick = strings.TrimSpace(accountNick)
	if serverID == "" || accountNick == "" {
		return nil, errors.New("serverID and accountNick are required")
	}

	since := s.now().Add(-time.Hour)
	count, err := s.Repository.CountSince(ctx, userID, since)
	if err != nil {
		return nil, err
	}
	if count >= int64(s.Config.RateLimitPerHour) {
		return nil, ErrRateLimited
	}

	return s.Repository.Create(ctx, userID, serverID, accountNick)
}

func (s *Service) GetClaim(ctx context.Context, id, userID uuid.UUID) (*NickClaim, error) {
	return s.Repository.FindByID(ctx, id, userID)
}

func (s *Service) ConsumeIfCaptured(ctx context.Context, id, userID uuid.UUID) (*NickClaim, error) {
	c, err := s.Repository.FindByID(ctx, id, userID)
	if err != nil {
		return nil, err
	}
	// Idempotency: once a row is consumed, return it as-is. Client
	// re-polling after a network glitch shouldn't get an error.
	if c.Status == StatusCaptured {
		if err := s.Repository.MarkConsumed(ctx, id, userID); err != nil {
			if !errors.Is(err, ErrStaleStatus) {
				return nil, err
			}
			// Lost the race against another concurrent poll —
			// re-read to pick up the new status.
		}
		c, err = s.Repository.FindByID(ctx, id, userID)
		if err != nil {
			return nil, err
		}
	}
	return c, nil
}

func (s *Service) EmailFor(c *NickClaim) string {
	// Strip dashes from the UUID for a shorter recipient local
	// part — keeps the total email under most IRC services'
	// "max email" config caps. e.g.
	//   reg+550e8400e29b41d4a716446655440000-abc12345@boson.chat
	// is 60 chars, well within typical 64-char limits.
	uid := strings.ReplaceAll(c.UserID.String(), "-", "")
	return fmt.Sprintf("reg+%s-%s@%s", uid, c.ShortToken, s.Config.EmailDomain)
}
