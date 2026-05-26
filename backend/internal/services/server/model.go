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
	VerificationToken         *string        `json:"-"`
	VerificationLastCheckedAt *time.Time     `json:"verification_last_checked_at,omitempty"`
	HealthStatus              string         `gorm:"not null" json:"health_status"`
	HealthLastCheckedAt       *time.Time     `json:"health_last_checked_at,omitempty"`
	UserCount                 *int           `json:"user_count,omitempty"`
	UserCountUpdatedAt        *time.Time     `json:"user_count_updated_at,omitempty"`
	RegisteredBy              *uuid.UUID     `gorm:"type:uuid" json:"registered_by,omitempty"`
	RegisteredAt              time.Time      `gorm:"not null;default:now()" json:"registered_at"`
}

func (Server) TableName() string { return "servers" }
