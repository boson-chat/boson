// Package authidentity maps auth-service user ids (the access token's
// `sub`, usr_<ULID>) to boson user ids (the uuid in users.id and every
// user_id column). See db/migrations/000010_auth_identities.up.sql.
package authidentity

import (
	"context"
	"errors"
	"strings"
	"sync"
	"time"

	"github.com/boson-chat/boson/backend/internal/db"

	"github.com/google/uuid"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

const (
	SourceSupabaseImport = "supabase_import"
	SourceAuto           = "auto"
)

// Namespace for the UUIDv5 given to accounts created on the auth service
// (no Supabase past). Fixed forever: changing it would orphan their data.
var Namespace = uuid.MustParse("7d0c3b8e-4f7a-5b2e-9a61-0b05a0c4a5e1")

var (
	ErrInvalidSubject = errors.New("authidentity: invalid subject")
	// ErrConflict: the auth user or the boson user is already mapped to
	// something else.
	ErrConflict = errors.New("authidentity: mapping conflict")
)

// Identity is one row of auth_identities.
type Identity struct {
	AuthUserID string    `gorm:"column:auth_user_id;primaryKey"`
	UserID     uuid.UUID `gorm:"column:user_id;type:uuid"`
	Source     string    `gorm:"column:source"`
	CreatedAt  time.Time `gorm:"column:created_at;default:now()"`
}

func (Identity) TableName() string { return "auth_identities" }

// DerivedUserID is the boson user id for an auth user with no imported
// mapping. UUIDv5 has version nibble 5, so it can't collide with the v4 ids
// Supabase handed out.
func DerivedUserID(authUserID string) uuid.UUID {
	return uuid.NewSHA1(Namespace, []byte(authUserID))
}

// ValidSubject reports whether sub looks like an auth-service user id.
func ValidSubject(sub string) bool {
	return strings.HasPrefix(sub, "usr_") && len(sub) > 4 && len(sub) <= 64
}

type ServiceImpl interface {
	// Resolve returns the boson user id for an auth user, creating the
	// mapping (with DerivedUserID) on first sight.
	Resolve(ctx context.Context, authUserID string) (uuid.UUID, error)
	// Find returns the mapping for an auth user, or ok=false.
	Find(ctx context.Context, authUserID string) (uuid.UUID, bool, error)
	// FindByUserID returns the auth user mapped to a boson user, or ok=false.
	FindByUserID(ctx context.Context, userID uuid.UUID) (string, bool, error)
	// Link records an explicit mapping (the Supabase import). Idempotent for
	// the same pair; ErrConflict if either side is mapped elsewhere.
	Link(ctx context.Context, authUserID string, userID uuid.UUID, source string) error
}

type Service struct {
	db *db.DB
	// Mappings never change once written, so positive results are cached
	// for the life of the process.
	cache sync.Map // auth_user_id → uuid.UUID
}

func NewService(database *db.DB) *Service {
	return &Service{db: database}
}

func (s *Service) Find(ctx context.Context, authUserID string) (uuid.UUID, bool, error) {
	if v, ok := s.cache.Load(authUserID); ok {
		return v.(uuid.UUID), true, nil
	}
	var row Identity
	err := s.db.DB.WithContext(ctx).Where("auth_user_id = ?", authUserID).First(&row).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return uuid.Nil, false, nil
	}
	if err != nil {
		return uuid.Nil, false, err
	}
	s.cache.Store(authUserID, row.UserID)
	return row.UserID, true, nil
}

func (s *Service) FindByUserID(ctx context.Context, userID uuid.UUID) (string, bool, error) {
	var row Identity
	err := s.db.DB.WithContext(ctx).Where("user_id = ?", userID).First(&row).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return "", false, nil
	}
	if err != nil {
		return "", false, err
	}
	return row.AuthUserID, true, nil
}

func (s *Service) Resolve(ctx context.Context, authUserID string) (uuid.UUID, error) {
	if !ValidSubject(authUserID) {
		return uuid.Nil, ErrInvalidSubject
	}
	if id, ok, err := s.Find(ctx, authUserID); err != nil || ok {
		return id, err
	}
	// First request from an account the import didn't know. ON CONFLICT DO
	// NOTHING makes concurrent first requests (or a racing import) safe;
	// re-read whatever won.
	row := Identity{AuthUserID: authUserID, UserID: DerivedUserID(authUserID), Source: SourceAuto}
	if err := s.db.DB.WithContext(ctx).Clauses(clause.OnConflict{DoNothing: true}).Create(&row).Error; err != nil {
		return uuid.Nil, err
	}
	id, ok, err := s.Find(ctx, authUserID)
	if err != nil {
		return uuid.Nil, err
	}
	if !ok {
		// The derived uuid is already mapped to another auth user: only
		// possible with a SHA-1 collision or a hand-edited table.
		return uuid.Nil, ErrConflict
	}
	return id, nil
}

func (s *Service) Link(ctx context.Context, authUserID string, userID uuid.UUID, source string) error {
	if !ValidSubject(authUserID) {
		return ErrInvalidSubject
	}
	row := Identity{AuthUserID: authUserID, UserID: userID, Source: source}
	res := s.db.DB.WithContext(ctx).Clauses(clause.OnConflict{DoNothing: true}).Create(&row)
	if res.Error != nil {
		return res.Error
	}
	if res.RowsAffected == 1 {
		s.cache.Store(authUserID, userID)
		return nil
	}
	// Nothing inserted: fine only if this exact pair already exists.
	got, ok, err := s.Find(ctx, authUserID)
	if err != nil {
		return err
	}
	if ok && got == userID {
		return nil
	}
	return ErrConflict
}
