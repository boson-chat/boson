// Package presence tracks each Boson member's current IRC identity per
// network (nick + host + services account), self-reported by their client,
// so other clients can detect which users they see in a channel are Boson
// members and show their profile image.
package presence

import (
	"time"

	"github.com/google/uuid"
)

// MemberPresence is one user's identity on one network. One row per
// (user, network); the client overwrites it on connect / nick change /
// host change / account change.
type MemberPresence struct {
	UserID    uuid.UUID `gorm:"type:uuid;primaryKey" json:"-"`
	Network   string    `gorm:"primaryKey" json:"network"`
	Nick      string    `gorm:"not null" json:"nick"`
	Host      string    `json:"host,omitempty"`
	Account   string    `json:"account,omitempty"`
	UpdatedAt time.Time `gorm:"not null;default:now()" json:"updated_at"`
}

func (MemberPresence) TableName() string { return "member_presence" }

// LookupItem is one user the caller observed in a channel.
type LookupItem struct {
	Nick    string
	Host    string
	Account string
}

// LookupMatch is a resolved Boson member for a queried nick. Host is
// deliberately NOT included — the lookup confirms membership without
// leaking anyone's hostname back to the caller.
type LookupMatch struct {
	Nick        string // the queried nick (what the caller sees in-channel)
	UserID      uuid.UUID
	Handle      string
	DisplayName *string
	AvatarKey   *string // R2 object key; the handler turns it into a CDN URL
}
