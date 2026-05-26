package user

import (
	"context"
	"errors"

	"github.com/boson-chat/boson/backend/internal/db"

	"github.com/google/uuid"
	"gorm.io/gorm"
)

var ErrNotFound = errors.New("user not found")

type UserRepositoryImpl interface {
	FindByID(ctx context.Context, id uuid.UUID) (*User, error)
	FindByHandle(ctx context.Context, handle string) (*User, error)
	Create(ctx context.Context, u *User) error
	Delete(ctx context.Context, id uuid.UUID) error
}

type UserRepository struct {
	db *db.DB
}

func NewUserRepository(database *db.DB) UserRepositoryImpl {
	return &UserRepository{db: database}
}

func (r *UserRepository) FindByID(ctx context.Context, id uuid.UUID) (*User, error) {
	var u User
	err := r.db.DB.WithContext(ctx).Where("id = ?", id).First(&u).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	return &u, nil
}

func (r *UserRepository) FindByHandle(ctx context.Context, handle string) (*User, error) {
	var u User
	err := r.db.DB.WithContext(ctx).Where("lower(handle) = lower(?)", handle).First(&u).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	return &u, nil
}

func (r *UserRepository) Create(ctx context.Context, u *User) error {
	return r.db.DB.WithContext(ctx).Create(u).Error
}

func (r *UserRepository) Delete(ctx context.Context, id uuid.UUID) error {
	// Cascading FKs (user_server_links, handle_changes) clean up dependents.
	res := r.db.DB.WithContext(ctx).Where("id = ?", id).Delete(&User{})
	if res.Error != nil {
		return res.Error
	}
	if res.RowsAffected == 0 {
		return ErrNotFound
	}
	return nil
}
