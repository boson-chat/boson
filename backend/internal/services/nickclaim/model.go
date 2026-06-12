// Package nickclaim tracks in-flight "claim a NickServ account on an
// IRC network" operations for signed-in Boson users.
//
// The flow: client POSTs to mint a NickClaim row, gets back an email
// address `reg-<userid>-<short_token>@<domain>`. Client passes that
// email to the IRC network's NickServ REGISTER command. NickServ
// emails the confirmation code; the IMAP worker captures it via the
// catch-all mailbox and writes it back to the row. Client polls the
// row by id and on capture fires NickServ CONFIRM/VERIFY REGISTER.
//
// short_token exists because a user may have multiple in-flight
// claims (one per IRC network) and they all share the same userid
// in the email local part — the short_token disambiguates which
// claim a given inbound email belongs to.
package nickclaim

import (
	"time"

	"github.com/google/uuid"
)

// Status values for NickClaim.Status. Kept as string constants
// instead of an enum type so we can use them directly in GORM
// queries without type-conversion noise.
const (
	StatusPending  = "pending"
	StatusCaptured = "captured"
	StatusConsumed = "consumed"
	StatusExpired  = "expired"
)

// TTL is how long a pending claim stays usable before the sweeper
// marks it expired. Most NickServ emails arrive within seconds; the
// 30-minute window covers slow MTAs + the case where the user
// closes the panel mid-flow and comes back.
const TTL = 30 * time.Minute

type NickClaim struct {
	ID          uuid.UUID  `gorm:"type:uuid;primaryKey" json:"id"`
	UserID      uuid.UUID  `gorm:"type:uuid;not null;index" json:"user_id"`
	ShortToken  string     `gorm:"uniqueIndex;not null" json:"short_token"`
	ServerID    string     `gorm:"not null" json:"server_id"`
	AccountNick string     `gorm:"not null" json:"account_nick"`
	Status      string     `gorm:"not null;default:'pending'" json:"status"`
	Code        *string    `json:"code,omitempty"`
	CreatedAt   time.Time  `gorm:"not null;default:now()" json:"created_at"`
	ExpiresAt   time.Time  `gorm:"not null" json:"expires_at"`
	ConsumedAt  *time.Time `json:"consumed_at,omitempty"`
	MailUID     *string    `gorm:"column:mail_uid" json:"mail_uid,omitempty"`
}

func (NickClaim) TableName() string { return "nick_claims" }
