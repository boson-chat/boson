package session

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"github.com/google/uuid"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"

	"github.com/boson-chat/boson/backend/internal/db"
)

var ErrNotFound = errors.New("session not found")

type RepositoryImpl interface {
	Get(ctx context.Context, userID uuid.UUID) (*UserSession, error)
	Upsert(ctx context.Context, userID uuid.UUID, payload json.RawMessage) (*UserSession, error)
}

type Repository struct {
	db *db.DB
}

func NewRepository(database *db.DB) RepositoryImpl {
	return &Repository{db: database}
}

func (r *Repository) Get(ctx context.Context, userID uuid.UUID) (*UserSession, error) {
	var s UserSession
	err := r.db.DB.WithContext(ctx).Where("user_id = ?", userID).First(&s).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	return &s, nil
}

func (r *Repository) Upsert(ctx context.Context, userID uuid.UUID, payload json.RawMessage) (*UserSession, error) {
	now := time.Now()
	s := UserSession{UserID: userID, Payload: payload, UpdatedAt: now}
	err := r.db.DB.WithContext(ctx).
		Clauses(clause.OnConflict{
			Columns:   []clause.Column{{Name: "user_id"}},
			DoUpdates: clause.AssignmentColumns([]string{"payload", "updated_at"}),
		}).
		Create(&s).Error
	if err != nil {
		return nil, err
	}
	return &s, nil
}
