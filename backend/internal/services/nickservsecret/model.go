package nickservsecret

import (
	"time"

	"github.com/google/uuid"
)

// NickservSecret is one per-(user, server) end-to-end-encrypted NickServ
// credential. Ciphertext is opaque to the server — the client encrypts
// {nickservPassword, accountName} under a key derived from its user_secret
// and we only ever store/return the blob. Serialized as base64 by Go's
// default []byte JSON encoding.
type NickservSecret struct {
	UserID     uuid.UUID `gorm:"type:uuid;primaryKey" json:"-"`
	ServerID   string    `gorm:"primaryKey" json:"server_id"`
	Ciphertext []byte    `gorm:"not null" json:"ciphertext"`
	UpdatedAt  time.Time `gorm:"not null;default:now()" json:"updated_at"`
}

func (NickservSecret) TableName() string { return "nickserv_secrets" }
