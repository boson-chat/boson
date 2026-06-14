package bouncersecret

import (
	"time"

	"github.com/google/uuid"
)

// BouncerSecret is the per-user, end-to-end-encrypted bouncer (ZNC/BNC)
// profile. Ciphertext is opaque to the server — the client encrypts
// {enabled, host, port, tls, tlsInsecure, username, password} under a key
// derived from its user_secret and we only ever store/return the blob.
// Single row per user (PK = user_id); the password lives ONLY inside the
// ciphertext. Serialized as base64 by Go's default []byte JSON encoding.
type BouncerSecret struct {
	UserID     uuid.UUID `gorm:"type:uuid;primaryKey" json:"-"`
	Ciphertext []byte    `gorm:"not null" json:"ciphertext"`
	UpdatedAt  time.Time `gorm:"not null;default:now()" json:"updated_at"`
}

func (BouncerSecret) TableName() string { return "bouncer_secret" }
