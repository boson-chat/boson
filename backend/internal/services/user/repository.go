package user

import (
	"context"
	"errors"
	"time"

	"github.com/boson-chat/boson/backend/internal/db"

	"github.com/google/uuid"
	"gorm.io/gorm"
)

var ErrNotFound = errors.New("user not found")

// HandleRedirectWindow is how long an old handle stays reserved after a
// rename. Lookups of the old handle should keep resolving back to the
// owner for this window so clients with stale references catch up.
const HandleRedirectWindow = 90 * 24 * time.Hour

type UserRepositoryImpl interface {
	FindByID(ctx context.Context, id uuid.UUID) (*User, error)
	FindByHandle(ctx context.Context, handle string) (*User, error)
	Create(ctx context.Context, u *User) error
	Delete(ctx context.Context, id uuid.UUID) error
	// UpdateHandle swaps the user's handle to newHandle in a single
	// transaction with a handle_changes audit row. Returns the refreshed
	// User on success, or ErrNotFound / a unique-violation error if the
	// new handle is taken.
	UpdateHandle(ctx context.Context, id uuid.UUID, newHandle string) (*User, error)
	// UpdateUserSecretWraps updates the password and/or recovery wrap of the
	// user_secret. A nil/empty slice leaves that column untouched. Returns the
	// refreshed User, or ErrNotFound.
	UpdateUserSecretWraps(ctx context.Context, id uuid.UUID, passwordWrap, recoveryWrap []byte) (*User, error)
	// UpdateAvatarKey sets (or clears, when key is nil) the user's
	// avatar_storage_key. Returns the refreshed User, or ErrNotFound.
	UpdateAvatarKey(ctx context.Context, id uuid.UUID, key *string) (*User, error)
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

func (r *UserRepository) UpdateUserSecretWraps(ctx context.Context, id uuid.UUID, passwordWrap, recoveryWrap []byte) (*User, error) {
	updates := map[string]any{}
	if len(passwordWrap) > 0 {
		updates["encrypted_user_secret"] = passwordWrap
	}
	if len(recoveryWrap) > 0 {
		updates["encrypted_user_secret_recovery"] = recoveryWrap
	}
	if len(updates) == 0 {
		return nil, ErrNotFound
	}
	res := r.db.DB.WithContext(ctx).Model(&User{}).Where("id = ?", id).Updates(updates)
	if res.Error != nil {
		return nil, res.Error
	}
	if res.RowsAffected == 0 {
		return nil, ErrNotFound
	}
	var refreshed User
	if err := r.db.DB.WithContext(ctx).Where("id = ?", id).First(&refreshed).Error; err != nil {
		return nil, err
	}
	return &refreshed, nil
}

func (r *UserRepository) UpdateAvatarKey(ctx context.Context, id uuid.UUID, key *string) (*User, error) {
	// Select on the column name so a nil key writes NULL (clears the avatar)
	// rather than being skipped as a zero value.
	res := r.db.DB.WithContext(ctx).Model(&User{}).
		Where("id = ?", id).
		Select("avatar_storage_key").
		Updates(map[string]any{"avatar_storage_key": key})
	if res.Error != nil {
		return nil, res.Error
	}
	if res.RowsAffected == 0 {
		return nil, ErrNotFound
	}
	var refreshed User
	if err := r.db.DB.WithContext(ctx).Where("id = ?", id).First(&refreshed).Error; err != nil {
		return nil, err
	}
	return &refreshed, nil
}

func (r *UserRepository) UpdateHandle(ctx context.Context, id uuid.UUID, newHandle string) (*User, error) {
	var refreshed User
	err := r.db.DB.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		var current User
		if err := tx.Where("id = ?", id).First(&current).Error; err != nil {
			if errors.Is(err, gorm.ErrRecordNotFound) {
				return ErrNotFound
			}
			return err
		}

		now := time.Now().UTC()

		// No-op when the handle is unchanged (case-sensitive) — return
		// the current row without writing an audit entry.
		if current.Handle == newHandle {
			refreshed = current
			return nil
		}

		change := HandleChange{
			UserID:        current.ID,
			OldHandle:     current.Handle,
			NewHandle:     newHandle,
			ChangedAt:     now,
			RedirectUntil: now.Add(HandleRedirectWindow),
		}
		if err := tx.Create(&change).Error; err != nil {
			return err
		}

		if err := tx.Model(&User{}).
			Where("id = ?", id).
			Updates(map[string]any{
				"handle":            newHandle,
				"handle_changed_at": now,
			}).Error; err != nil {
			return err
		}

		if err := tx.Where("id = ?", id).First(&refreshed).Error; err != nil {
			return err
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	return &refreshed, nil
}
