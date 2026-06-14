package bouncersecret

import (
	"context"
	"errors"
	"time"

	"github.com/google/uuid"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"

	"github.com/boson-chat/boson/backend/internal/db"
)

var ErrNotFound = errors.New("bouncer secret not found")

type RepositoryImpl interface {
	// Get returns the user's bouncer blob, or ErrNotFound when none exists.
	// Scoped by user_id for RLS at the query level.
	Get(ctx context.Context, userID uuid.UUID) (*BouncerSecret, error)
	// Upsert stores/replaces the ciphertext for the user.
	Upsert(ctx context.Context, userID uuid.UUID, ciphertext []byte) (*BouncerSecret, error)
	// Delete removes the user's row. Idempotent — no error when absent.
	Delete(ctx context.Context, userID uuid.UUID) error
}

type Repository struct {
	db *db.DB
}

func NewRepository(database *db.DB) RepositoryImpl {
	return &Repository{db: database}
}

func (r *Repository) Get(ctx context.Context, userID uuid.UUID) (*BouncerSecret, error) {
	var out BouncerSecret
	err := r.db.DB.WithContext(ctx).
		Where("user_id = ?", userID).
		First(&out).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	return &out, nil
}

func (r *Repository) Upsert(ctx context.Context, userID uuid.UUID, ciphertext []byte) (*BouncerSecret, error) {
	s := BouncerSecret{
		UserID:     userID,
		Ciphertext: ciphertext,
		UpdatedAt:  time.Now(),
	}
	err := r.db.DB.WithContext(ctx).
		Clauses(clause.OnConflict{
			Columns:   []clause.Column{{Name: "user_id"}},
			DoUpdates: clause.AssignmentColumns([]string{"ciphertext", "updated_at"}),
		}).
		Create(&s).Error
	if err != nil {
		return nil, err
	}
	return &s, nil
}

func (r *Repository) Delete(ctx context.Context, userID uuid.UUID) error {
	// Idempotent: a delete with no matching row is a no-op (DELETE returns 204
	// regardless), so we don't surface RowsAffected == 0 as an error.
	return r.db.DB.WithContext(ctx).
		Where("user_id = ?", userID).
		Delete(&BouncerSecret{}).Error
}
