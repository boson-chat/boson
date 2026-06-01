package user

import (
	"time"

	"github.com/google/uuid"
)

type User struct {
	ID                  uuid.UUID  `gorm:"type:uuid;primaryKey" json:"id"`
	Handle              string     `gorm:"uniqueIndex;not null" json:"handle"`
	DisplayName         *string    `json:"display_name,omitempty"`
	AvatarStorageKey    *string    `json:"avatar_storage_key,omitempty"`
	IsDiscoverable      bool       `gorm:"not null;default:true" json:"is_discoverable"`
	// Serialized as a base64 string by Go's encoding/json default for []byte.
	// Safe to expose to the authenticated user — only the holder of the
	// platform password can decrypt it, and the JWT already proves identity.
	EncryptedUserSecret []byte     `gorm:"not null" json:"encrypted_user_secret"`
	HandleChangedAt     *time.Time `json:"handle_changed_at,omitempty"`
	CreatedAt           time.Time  `gorm:"not null;default:now()" json:"created_at"`
}

func (User) TableName() string { return "users" }

// HandleChange is one audit row written every time a user renames their
// handle. redirect_until is how long the old handle stays reserved (so
// lookups of stale identifiers still resolve back to the same user
// while clients catch up).
type HandleChange struct {
	UserID        uuid.UUID `gorm:"type:uuid;primaryKey" json:"user_id"`
	OldHandle     string    `gorm:"not null" json:"old_handle"`
	NewHandle     string    `gorm:"not null" json:"new_handle"`
	ChangedAt     time.Time `gorm:"primaryKey;not null;default:now()" json:"changed_at"`
	RedirectUntil time.Time `gorm:"not null" json:"redirect_until"`
}

func (HandleChange) TableName() string { return "handle_changes" }
