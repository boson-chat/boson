package server

import (
	"context"
	"errors"
	"strings"
	"time"

	"github.com/boson-chat/boson/backend/internal/db"

	"github.com/google/uuid"
	"gorm.io/gorm"
)

var ErrNotFound = errors.New("server not found")

type ListFilter struct {
	Query       string
	Language    string
	IncludeNSFW bool
	Sort        string // "users" | "newest" | "active" (default: "users")
	Limit       int
	Offset      int
	// Status optionally pins the list to a single verification status.
	// Empty = no filter (used by admin paths + the existing test seed).
	// Public GET /servers passes "verified" so pending / lapsed rows
	// don't pollute the user-facing directory.
	Status string
}

type ServerRepositoryImpl interface {
	List(ctx context.Context, f ListFilter) ([]*Server, error)
	FindByID(ctx context.Context, id uuid.UUID) (*Server, error)
	Create(ctx context.Context, s *Server) error
	// UpdateColumns persists only the named columns from s (by primary
	// key). Callers Find → mutate → UpdateColumns with exactly the
	// columns they changed, so a concurrent write to any other column
	// (an owner editing the name while the cron records a health probe,
	// say) isn't reverted by a stale full-row write.
	UpdateColumns(ctx context.Context, s *Server, columns ...string) error
	// ListBatchForCron returns up to limit servers whose
	// verification_status is in statuses and whose id sorts after
	// afterID (uuid.Nil = start), ordered by id. Unlike List it applies
	// no NSFW filter and no limit clamp — the background workers must
	// see every listing. Callers page by passing the last row's ID back.
	ListBatchForCron(ctx context.Context, statuses []string, afterID uuid.UUID, limit int) ([]*Server, error)
	// RecordVerifyResult writes the verify cron's verdict (status +
	// last-checked) only if the row still carries the token that was
	// checked. Returns false when the owner regenerated the token in
	// the meantime, in which case nothing is written.
	RecordVerifyResult(ctx context.Context, id uuid.UUID, checkedToken, status string, checkedAt time.Time) (bool, error)
	// RecordHealthResult writes the health cron's verdict. It touches
	// only the health_* columns the cron owns.
	RecordHealthResult(ctx context.Context, id uuid.UUID, status string, checkedAt time.Time) error
	// ListByOwner returns every server registered by principalID
	// regardless of verification status, sorted newest-first. Drives
	// GET /servers/me in the API. Token is included on the model and
	// the HTTP layer redacts it for non-pending rows via ToOwnerView.
	ListByOwner(ctx context.Context, principalID uuid.UUID) ([]*Server, error)
}

type ServerRepository struct {
	db *db.DB
}

func NewServerRepository(database *db.DB) ServerRepositoryImpl {
	return &ServerRepository{db: database}
}

func (r *ServerRepository) List(ctx context.Context, f ListFilter) ([]*Server, error) {
	q := r.db.DB.WithContext(ctx).Model(&Server{})

	if !f.IncludeNSFW {
		q = q.Where("is_nsfw = false")
	}
	if f.Language != "" {
		q = q.Where("? = ANY(languages)", f.Language)
	}
	if f.Status != "" {
		q = q.Where("verification_status = ?", f.Status)
	}
	if tsq := buildPrefixTSQuery(f.Query); tsq != "" {
		q = q.Where("search_vector @@ to_tsquery('simple', ?)", tsq)
	}

	switch f.Sort {
	case "newest":
		q = q.Order("registered_at DESC")
	case "active":
		q = q.Order("user_count_updated_at DESC NULLS LAST")
	default:
		q = q.Order("user_count DESC NULLS LAST, registered_at DESC")
	}

	if f.Limit <= 0 || f.Limit > 100 {
		f.Limit = 25
	}
	q = q.Limit(f.Limit).Offset(f.Offset)

	var servers []*Server
	if err := q.Find(&servers).Error; err != nil {
		return nil, err
	}
	return servers, nil
}

func (r *ServerRepository) Create(ctx context.Context, s *Server) error {
	return r.db.DB.WithContext(ctx).Create(s).Error
}

// buildPrefixTSQuery turns user input into a to_tsquery('simple', ...) string
// where every word becomes a prefix match (so "myelin" matches "myelinbots",
// "libera" matches "libera.chat") and multiple words are ANDed. All non-
// alphanumeric characters are stripped to keep to_tsquery from throwing on
// special operators it parses (& | ! : * etc.).
func buildPrefixTSQuery(input string) string {
	words := strings.Fields(input)
	terms := make([]string, 0, len(words))
	for _, w := range words {
		clean := strings.Map(func(r rune) rune {
			switch {
			case r >= 'a' && r <= 'z',
				r >= 'A' && r <= 'Z',
				r >= '0' && r <= '9',
				r == '-', r == '_', r == '.':
				return r
			}
			return -1
		}, w)
		if clean == "" {
			continue
		}
		terms = append(terms, clean+":*")
	}
	return strings.Join(terms, " & ")
}

func (r *ServerRepository) FindByID(ctx context.Context, id uuid.UUID) (*Server, error) {
	var s Server
	err := r.db.DB.WithContext(ctx).Where("id = ?", id).First(&s).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	return &s, nil
}

// UpdateColumns writes only the named columns. Select + Updates (rather
// than Save) scopes the UPDATE to those columns, and naming them in
// Select also makes gorm write zero values (nil timestamps, false
// bools, empty arrays) that a bare struct Updates would skip.
func (r *ServerRepository) UpdateColumns(ctx context.Context, s *Server, columns ...string) error {
	if len(columns) == 0 {
		return nil
	}
	if s.ID == uuid.Nil {
		return ErrNotFound
	}
	return r.db.DB.WithContext(ctx).Model(s).Select(columns).Updates(s).Error
}

func (r *ServerRepository) ListBatchForCron(ctx context.Context, statuses []string, afterID uuid.UUID, limit int) ([]*Server, error) {
	if limit <= 0 {
		limit = 500
	}
	var servers []*Server
	err := r.db.DB.WithContext(ctx).
		Where("verification_status IN ?", statuses).
		Where("id > ?", afterID).
		Order("id ASC").
		Limit(limit).
		Find(&servers).Error
	if err != nil {
		return nil, err
	}
	return servers, nil
}

func (r *ServerRepository) RecordVerifyResult(ctx context.Context, id uuid.UUID, checkedToken, status string, checkedAt time.Time) (bool, error) {
	res := r.db.DB.WithContext(ctx).Model(&Server{}).
		Where("id = ? AND verification_token = ?", id, checkedToken).
		Updates(map[string]any{
			"verification_status":          status,
			"verification_last_checked_at": checkedAt,
		})
	if res.Error != nil {
		return false, res.Error
	}
	return res.RowsAffected > 0, nil
}

func (r *ServerRepository) RecordHealthResult(ctx context.Context, id uuid.UUID, status string, checkedAt time.Time) error {
	return r.db.DB.WithContext(ctx).Model(&Server{}).
		Where("id = ?", id).
		Updates(map[string]any{
			"health_status":          status,
			"health_last_checked_at": checkedAt,
		}).Error
}

func (r *ServerRepository) ListByOwner(ctx context.Context, principalID uuid.UUID) ([]*Server, error) {
	var servers []*Server
	err := r.db.DB.WithContext(ctx).
		Where("registered_by = ?", principalID).
		Order("registered_at DESC").
		Find(&servers).Error
	if err != nil {
		return nil, err
	}
	return servers, nil
}
