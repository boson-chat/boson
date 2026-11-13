package supabaseimport

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/boson-chat/boson/backend/internal/db"
	"github.com/boson-chat/boson/backend/internal/services/authidentity"

	"github.com/google/uuid"
	"github.com/oklog/ulid/v2"
)

// NewAuthUserID makes an id in the auth service's format (usr_<ULID>).
func NewAuthUserID() string { return "usr_" + ulid.Make().String() }

// SQLAuthStore writes straight into the auth service's Postgres (schema:
// github.com/boson-chat/auth db/migrations/000001_initial.up.sql). The auth
// service has no import API; its tables are plain enough to insert into.
type SQLAuthStore struct{ DB *sql.DB }

func (s SQLAuthStore) TakenUsernames(ctx context.Context) (map[string]struct{}, error) {
	rows, err := s.DB.QueryContext(ctx, `SELECT username_folded FROM users`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]struct{}{}
	for rows.Next() {
		var f string
		if err := rows.Scan(&f); err != nil {
			return nil, err
		}
		out[f] = struct{}{}
	}
	return out, rows.Err()
}

func (s SQLAuthStore) ExistingByEmail(ctx context.Context) (map[string]ExistingAuthUser, error) {
	rows, err := s.DB.QueryContext(ctx, `SELECT id, username, lower(email::text), email_verified_at IS NOT NULL FROM users WHERE email IS NOT NULL`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]ExistingAuthUser{}
	for rows.Next() {
		var u ExistingAuthUser
		var email string
		if err := rows.Scan(&u.ID, &u.Username, &email, &u.EmailVerified); err != nil {
			return nil, err
		}
		out[email] = u
	}
	return out, rows.Err()
}

// CreateUser inserts the user (and its bcrypt credential) in one
// transaction, plus an audit_log row so the auth service's admin audit view
// shows where the account came from.
func (s SQLAuthStore) CreateUser(ctx context.Context, p Planned) error {
	tx, err := s.DB.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	created := p.Supabase.CreatedAt
	if created.IsZero() {
		created = time.Now().UTC()
	}
	var verified, disabled any
	if p.EmailVerified {
		verified = *p.Supabase.EmailConfirmedAt
	}
	if p.Disabled {
		disabled = time.Now().UTC()
	}
	if _, err := tx.ExecContext(ctx, `
		INSERT INTO users (id, username, username_folded, email, email_verified_at, role, disabled_at, created_at, updated_at)
		VALUES ($1, $2, $3, $4, $5, 'user', $6, $7, now())`,
		p.AuthUserID, p.Username, foldNick(p.Username), p.Supabase.Email, verified, disabled, created); err != nil {
		return fmt.Errorf("insert user: %w", err)
	}
	if p.PasswordHash != "" {
		if _, err := tx.ExecContext(ctx, `INSERT INTO password_credentials (user_id, hash) VALUES ($1, $2)`,
			p.AuthUserID, p.PasswordHash); err != nil {
			return fmt.Errorf("insert password: %w", err)
		}
	}
	meta, _ := json.Marshal(map[string]any{
		"source": "supabase_import", "supabase_id": p.Supabase.ID.String(), "password_imported": p.PasswordHash != "",
	})
	if _, err := tx.ExecContext(ctx, `INSERT INTO audit_log (id, user_id, event, meta) VALUES ($1, $2, 'user_imported', $3)`,
		"aud_"+ulid.Make().String(), p.AuthUserID, meta); err != nil {
		return fmt.Errorf("insert audit: %w", err)
	}
	return tx.Commit()
}

// GormBosonStore is boson's own database.
type GormBosonStore struct {
	DB         *db.DB
	Identities authidentity.ServiceImpl
}

func (s GormBosonStore) Handles(ctx context.Context) (map[uuid.UUID]string, error) {
	var rows []struct {
		ID     uuid.UUID
		Handle string
	}
	if err := s.DB.DB.WithContext(ctx).Table("users").Select("id, handle").Scan(&rows).Error; err != nil {
		return nil, err
	}
	out := make(map[uuid.UUID]string, len(rows))
	for _, r := range rows {
		out[r.ID] = r.Handle
	}
	return out, nil
}

func (s GormBosonStore) Mapped(ctx context.Context) (map[uuid.UUID]string, error) {
	var rows []authidentity.Identity
	if err := s.DB.DB.WithContext(ctx).Find(&rows).Error; err != nil {
		return nil, err
	}
	out := make(map[uuid.UUID]string, len(rows))
	for _, r := range rows {
		out[r.UserID] = r.AuthUserID
	}
	return out, nil
}

func (s GormBosonStore) Link(ctx context.Context, authUserID string, supabaseID uuid.UUID) error {
	return s.Identities.Link(ctx, authUserID, supabaseID, authidentity.SourceSupabaseImport)
}

// ResetMailer asks the auth service to send password-reset emails through
// its public API (POST /v1/password/forgot), the same mail a user gets from
// "Forgot password?". Interval spaces requests to stay under the auth
// service's per-IP rate limit (RATE_LIMIT_IP_PER_MINUTE, default 10/min).
type ResetMailer struct {
	BaseURL  string
	Interval time.Duration
	Client   *http.Client
}

func (m ResetMailer) Send(ctx context.Context, email string) error {
	body, _ := json.Marshal(map[string]string{"email": email})
	for attempt := 0; attempt < 5; attempt++ {
		req, err := http.NewRequestWithContext(ctx, http.MethodPost, strings.TrimRight(m.BaseURL, "/")+"/v1/password/forgot", bytes.NewReader(body))
		if err != nil {
			return err
		}
		req.Header.Set("Content-Type", "application/json")
		c := m.Client
		if c == nil {
			c = &http.Client{Timeout: 15 * time.Second}
		}
		res, err := c.Do(req)
		if err != nil {
			return err
		}
		res.Body.Close()
		switch {
		case res.StatusCode == http.StatusAccepted || res.StatusCode == http.StatusOK:
			return nil
		case res.StatusCode == http.StatusTooManyRequests:
			wait := 10 * time.Second
			if s := res.Header.Get("Retry-After"); s != "" {
				if d, err := time.ParseDuration(s + "s"); err == nil {
					wait = d
				}
			}
			select {
			case <-time.After(wait):
			case <-ctx.Done():
				return ctx.Err()
			}
		default:
			return fmt.Errorf("password/forgot: HTTP %d", res.StatusCode)
		}
	}
	return errors.New("password/forgot: still rate limited after 5 tries")
}
