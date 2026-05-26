package session

import (
	"encoding/json"
	"time"

	"github.com/google/uuid"
)

// UserSession holds the per-user saved session blob — the client's
// SessionStore record (servers, joined channels, active cursor) serialised
// as JSONB. Kept opaque on the server because the schema is owned by the
// renderer and we don't want a backend migration every time the client
// adds a field.
type UserSession struct {
	UserID    uuid.UUID       `gorm:"type:uuid;primaryKey" json:"user_id"`
	Payload   json.RawMessage `gorm:"type:jsonb;not null;default:'{}'" json:"payload"`
	UpdatedAt time.Time       `gorm:"not null;default:now()" json:"updated_at"`
}

func (UserSession) TableName() string { return "user_sessions" }
