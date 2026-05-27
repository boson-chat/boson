package server

import (
	"context"
	"errors"
	"strings"

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
	// Update persists every column on s. Used by the verify + regenerate
	// flows where status, token, and the *_at timestamps move together;
	// callers Find → mutate → Update so we get a single atomic write.
	Update(ctx context.Context, s *Server) error
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

// Update persists every column on s. We use gorm Save (PK-based UPDATE
// across all columns) rather than Updates, because the verify flow writes
// nullable timestamps to non-null values and a struct-level Updates would
// silently skip them per gorm's zero-value rules.
func (r *ServerRepository) Update(ctx context.Context, s *Server) error {
	return r.db.DB.WithContext(ctx).Save(s).Error
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
