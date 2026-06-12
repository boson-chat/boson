package server

import (
	"time"

	"github.com/google/uuid"
	"github.com/lib/pq"
)

// NOTE on GORM tags: we deliberately do NOT use `default:` here. GORM omits
// fields from INSERT when the value matches the struct's zero value AND a
// `default:` tag is present, which silently substitutes the DB column default.
// That bit us when TLS was registered as false but stored as true. Migration
// SQL still carries the column defaults, but they only apply when the column
// is omitted from INSERT — which we never want to happen from the app side.
type Server struct {
	ID                        uuid.UUID      `gorm:"type:uuid;primaryKey;default:gen_random_uuid()" json:"id"`
	Hostname                  string         `gorm:"not null" json:"hostname"`
	Port                      int            `gorm:"not null" json:"port"`
	TLS                       bool           `gorm:"not null" json:"tls"`
	Name                      string         `gorm:"not null" json:"name"`
	Description               *string        `json:"description,omitempty"`
	Tags                      pq.StringArray `gorm:"type:text[];not null" json:"tags"`
	Languages                 pq.StringArray `gorm:"type:text[];not null" json:"languages"`
	IsNSFW                    bool           `gorm:"column:is_nsfw;not null" json:"is_nsfw"`
	IsFeatured                bool           `gorm:"not null" json:"is_featured"`
	VerificationStatus        string         `gorm:"not null" json:"verification_status"`
	// VerificationToken stays redacted in normal JSON marshalling (`json:"-"`)
	// so the public GET /servers and GET /servers/{id} responses never expose
	// it. The /servers/me endpoint marshals through a separate view struct
	// (ServerWithToken) when the caller is the row's owner AND the row is
	// still pending — see ToOwnerView below.
	VerificationToken           *string    `json:"-"`
	VerificationTokenIssuedAt   *time.Time `gorm:"column:verification_token_issued_at" json:"-"`
	VerificationLastCheckedAt   *time.Time `json:"verification_last_checked_at,omitempty"`
	HealthStatus              string         `gorm:"not null" json:"health_status"`
	HealthLastCheckedAt       *time.Time     `json:"health_last_checked_at,omitempty"`
	UserCount                 *int           `json:"user_count,omitempty"`
	UserCountUpdatedAt        *time.Time     `json:"user_count_updated_at,omitempty"`
	RegisteredBy              *uuid.UUID     `gorm:"type:uuid" json:"registered_by,omitempty"`
	RegisteredAt              time.Time      `gorm:"not null;default:now()" json:"registered_at"`
	// Profile-image R2 object keys (icon = square, banner = wide). Kept out
	// of JSON; the API derives the public CDN URLs into IconURL/BannerURL.
	IconStorageKey   *string `gorm:"column:icon_storage_key" json:"-"`
	BannerStorageKey *string `gorm:"column:banner_storage_key" json:"-"`
	// Computed CDN URLs (not persisted) — populated by the handler from the
	// storage keys + CDN base before marshalling.
	IconURL   string `gorm:"-" json:"icon_url,omitempty"`
	BannerURL string `gorm:"-" json:"banner_url,omitempty"`
}

func (Server) TableName() string { return "servers" }

// ServerWithToken is the response shape returned from owner-scoped routes
// (POST /servers, POST /servers/{id}/regenerate-token, GET /servers/me on
// pending rows). It embeds Server so JSON consumers see every public field
// plus the still-pending verification_token. Once a row reaches
// `verified` / `lapsed`, the token is no longer included even on the
// owner-scoped GET so it doesn't accidentally re-leak after issuance.
type ServerWithToken struct {
	*Server
	VerificationToken         string    `json:"verification_token"`
	VerificationTokenIssuedAt time.Time `json:"verification_token_issued_at"`
}

// ToOwnerView wraps a Server into the token-bearing view ONLY when the row
// is still pending. Verified / lapsed rows fall back to the public shape
// so the token is dropped from the response.
func (s *Server) ToOwnerView() any {
	if s.VerificationStatus != "pending" || s.VerificationToken == nil || s.VerificationTokenIssuedAt == nil {
		return s
	}
	return ServerWithToken{
		Server:                    s,
		VerificationToken:         *s.VerificationToken,
		VerificationTokenIssuedAt: *s.VerificationTokenIssuedAt,
	}
}
