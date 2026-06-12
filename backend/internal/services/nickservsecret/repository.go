package nickservsecret

import (
	"context"
	"errors"
	"time"

	"github.com/google/uuid"
	"gorm.io/gorm/clause"

	"github.com/boson-chat/boson/backend/internal/db"
)

var ErrNotFound = errors.New("nickserv secret not found")

type RepositoryImpl interface {
	// List returns all of the user's secrets (every server). Scoped by
	// user_id for RLS at the query level.
	List(ctx context.Context, userID uuid.UUID) ([]NickservSecret, error)
	// Upsert stores/replaces the ciphertext for (user, server).
	Upsert(ctx context.Context, userID uuid.UUID, serverID string, ciphertext []byte) (*NickservSecret, error)
	// Delete removes the (user, server) row. Returns ErrNotFound if absent.
	Delete(ctx context.Context, userID uuid.UUID, serverID string) error
}

type Repository struct {
	db *db.DB
}

func NewRepository(database *db.DB) RepositoryImpl {
	return &Repository{db: database}
}

func (r *Repository) List(ctx context.Context, userID uuid.UUID) ([]NickservSecret, error) {
	var out []NickservSecret
	err := r.db.DB.WithContext(ctx).
		Where("user_id = ?", userID).
		Order("server_id").
		Find(&out).Error
	if err != nil {
		return nil, err
	}
	return out, nil
}

func (r *Repository) Upsert(ctx context.Context, userID uuid.UUID, serverID string, ciphertext []byte) (*NickservSecret, error) {
	s := NickservSecret{
		UserID:     userID,
		ServerID:   serverID,
		Ciphertext: ciphertext,
		UpdatedAt:  time.Now(),
	}
	err := r.db.DB.WithContext(ctx).
		Clauses(clause.OnConflict{
			Columns:   []clause.Column{{Name: "user_id"}, {Name: "server_id"}},
			DoUpdates: clause.AssignmentColumns([]string{"ciphertext", "updated_at"}),
		}).
		Create(&s).Error
	if err != nil {
		return nil, err
	}
	return &s, nil
}

func (r *Repository) Delete(ctx context.Context, userID uuid.UUID, serverID string) error {
	res := r.db.DB.WithContext(ctx).
		Where("user_id = ? AND server_id = ?", userID, serverID).
		Delete(&NickservSecret{})
	if res.Error != nil {
		return res.Error
	}
	if res.RowsAffected == 0 {
		return ErrNotFound
	}
	return nil
}
