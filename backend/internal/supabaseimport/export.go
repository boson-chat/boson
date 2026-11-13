// Package supabaseimport moves Supabase Auth accounts (auth.users) into the
// boson auth service and records supabase_id → auth user id in boson's
// auth_identities, so existing boson data keeps resolving after the
// cutover. Used by `server import-supabase-users`; the runbook is
// docs/migration-supabase-to-auth.md.
package supabaseimport

import (
	"bufio"
	"bytes"
	"encoding/csv"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
)

// SupabaseUser is one row of Supabase's auth.users, as exported by
//
//	\copy (SELECT id, email, encrypted_password, email_confirmed_at,
//	              raw_user_meta_data, created_at, banned_until, deleted_at,
//	              is_anonymous FROM auth.users) TO 'users.csv' CSV HEADER
//
// or the same columns as a JSON array / NDJSON. Only id and email are
// required; the last three columns are optional.
type SupabaseUser struct {
	ID                uuid.UUID
	Email             string
	EncryptedPassword string // bcrypt ($2a$…), or "" for OAuth / magic-link users
	EmailConfirmedAt  *time.Time
	Metadata          map[string]any // raw_user_meta_data
	CreatedAt         time.Time
	BannedUntil       *time.Time
	DeletedAt         *time.Time
	IsAnonymous       bool
}

// ReadExport reads a .csv (with a header row), .json (array) or .jsonl /
// .ndjson file.
func ReadExport(path string) ([]SupabaseUser, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	switch {
	case strings.HasSuffix(path, ".csv"):
		return parseCSV(bytes.NewReader(raw))
	case strings.HasSuffix(path, ".json"):
		var rows []map[string]any
		if err := json.Unmarshal(raw, &rows); err != nil {
			return nil, fmt.Errorf("%s: %w", path, err)
		}
		return fromMaps(rows)
	case strings.HasSuffix(path, ".jsonl"), strings.HasSuffix(path, ".ndjson"):
		var rows []map[string]any
		sc := bufio.NewScanner(bytes.NewReader(raw))
		sc.Buffer(make([]byte, 1<<20), 16<<20)
		for sc.Scan() {
			line := bytes.TrimSpace(sc.Bytes())
			if len(line) == 0 {
				continue
			}
			var m map[string]any
			if err := json.Unmarshal(line, &m); err != nil {
				return nil, fmt.Errorf("%s: %w", path, err)
			}
			rows = append(rows, m)
		}
		if err := sc.Err(); err != nil {
			return nil, err
		}
		return fromMaps(rows)
	}
	return nil, fmt.Errorf("%s: want a .csv, .json, .jsonl or .ndjson export", path)
}

func parseCSV(r io.Reader) ([]SupabaseUser, error) {
	cr := csv.NewReader(r)
	header, err := cr.Read()
	if err != nil {
		return nil, fmt.Errorf("csv header: %w", err)
	}
	var rows []map[string]any
	for {
		rec, err := cr.Read()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return nil, err
		}
		m := map[string]any{}
		for i, h := range header {
			if i < len(rec) && rec[i] != "" {
				m[strings.TrimSpace(h)] = rec[i]
			}
		}
		rows = append(rows, m)
	}
	return fromMaps(rows)
}

func fromMaps(rows []map[string]any) ([]SupabaseUser, error) {
	out := make([]SupabaseUser, 0, len(rows))
	for i, m := range rows {
		u, err := fromMap(m)
		if err != nil {
			return nil, fmt.Errorf("row %d: %w", i+1, err)
		}
		out = append(out, u)
	}
	return out, nil
}

func fromMap(m map[string]any) (SupabaseUser, error) {
	var u SupabaseUser
	id, err := uuid.Parse(str(m["id"]))
	if err != nil {
		return u, fmt.Errorf("id: %w", err)
	}
	u.ID = id
	u.Email = strings.TrimSpace(str(m["email"]))
	u.EncryptedPassword = str(m["encrypted_password"])
	if u.EmailConfirmedAt, err = optTime(m["email_confirmed_at"]); err != nil {
		return u, fmt.Errorf("email_confirmed_at: %w", err)
	}
	if t, err := optTime(m["created_at"]); err != nil {
		return u, fmt.Errorf("created_at: %w", err)
	} else if t != nil {
		u.CreatedAt = *t
	}
	if u.BannedUntil, err = optTime(m["banned_until"]); err != nil {
		return u, fmt.Errorf("banned_until: %w", err)
	}
	if u.DeletedAt, err = optTime(m["deleted_at"]); err != nil {
		return u, fmt.Errorf("deleted_at: %w", err)
	}
	switch v := m["is_anonymous"].(type) {
	case bool:
		u.IsAnonymous = v
	case string:
		// Postgres CSV prints booleans as t / f.
		b, err := strconv.ParseBool(v)
		u.IsAnonymous = (err == nil && b) || v == "t"
	}
	switch v := m["raw_user_meta_data"].(type) {
	case map[string]any:
		u.Metadata = v
	case string:
		if v != "" {
			if err := json.Unmarshal([]byte(v), &u.Metadata); err != nil {
				return u, fmt.Errorf("raw_user_meta_data: %w", err)
			}
		}
	}
	return u, nil
}

func str(v any) string {
	if s, ok := v.(string); ok {
		return s
	}
	return ""
}

// Postgres text output ("2024-05-01 12:34:56.789+00") and RFC 3339.
var timeLayouts = []string{
	time.RFC3339Nano,
	"2006-01-02 15:04:05.999999999-07",
	"2006-01-02 15:04:05.999999999-07:00",
	"2006-01-02 15:04:05.999999999Z07:00",
	"2006-01-02T15:04:05.999999999",
	"2006-01-02 15:04:05.999999999",
}

func optTime(v any) (*time.Time, error) {
	s := strings.TrimSpace(str(v))
	if s == "" {
		return nil, nil
	}
	for _, l := range timeLayouts {
		if t, err := time.Parse(l, s); err == nil {
			t = t.UTC()
			return &t, nil
		}
	}
	return nil, fmt.Errorf("unrecognised time %q", s)
}
