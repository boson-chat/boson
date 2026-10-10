package presence

import (
	"context"
	"strings"
	"time"

	"github.com/google/uuid"
	"gorm.io/gorm/clause"

	"github.com/boson-chat/boson/backend/internal/db"
)

type RepositoryImpl interface {
	// Upsert stores/replaces the caller's identity on a network (one row per
	// user+network). Scoped to user_id.
	Upsert(ctx context.Context, userID uuid.UUID, network, nick, host, account string) (*MemberPresence, error)
	// Lookup resolves which of the queried users on `network` are Boson
	// members. Hybrid match: the strong (network, account) key when an
	// account is given, else the (network, nick, host) fallback. Only
	// discoverable users are returned, and a key claimed by more than one
	// user is treated as ambiguous and matches nobody (see Lookup).
	Lookup(ctx context.Context, network string, items []LookupItem) ([]LookupMatch, error)
}

type Repository struct {
	db *db.DB
}

func NewRepository(database *db.DB) RepositoryImpl {
	return &Repository{db: database}
}

func (r *Repository) Upsert(ctx context.Context, userID uuid.UUID, network, nick, host, account string) (*MemberPresence, error) {
	p := MemberPresence{
		UserID:    userID,
		Network:   network,
		Nick:      nick,
		Host:      host,
		Account:   account,
		UpdatedAt: time.Now(),
	}
	err := r.db.DB.WithContext(ctx).
		Clauses(clause.OnConflict{
			Columns:   []clause.Column{{Name: "user_id"}, {Name: "network"}},
			DoUpdates: clause.AssignmentColumns([]string{"nick", "host", "account", "updated_at"}),
		}).
		Create(&p).Error
	if err != nil {
		return nil, err
	}
	return &p, nil
}

func (r *Repository) Lookup(ctx context.Context, network string, items []LookupItem) ([]LookupMatch, error) {
	if network == "" || len(items) == 0 {
		return nil, nil
	}

	// One query: all Boson members present on this network, joined to their
	// user row. Networks have at most dozens of Boson members, so matching
	// the (typically larger) queried set against this in Go is cheap and far
	// simpler than per-item SQL with two match modes.
	type row struct {
		Nick             string
		Host             string
		Account          string
		UserID           uuid.UUID
		Handle           string
		DisplayName      *string
		AvatarStorageKey *string
	}
	var rows []row
	err := r.db.DB.WithContext(ctx).
		Table("member_presence AS p").
		Select("p.nick, p.host, p.account, u.id AS user_id, u.handle, u.display_name, u.avatar_storage_key").
		Joins("JOIN users u ON u.id = p.user_id").
		Where("p.network = ?", network).
		// Users who opted out of discovery must not be identifiable by
		// anyone who can see them in a channel.
		Where("u.is_discoverable = true").
		Scan(&rows).Error
	if err != nil {
		return nil, err
	}

	// Identities are self-reported, so nothing stops a second user from
	// publishing someone else's account (or nick+host), and letting
	// whichever row scanned last win was both nondeterministic and an
	// impersonation vector. Instead, a key claimed by more than one user
	// is ambiguous and resolves to nobody: a squatter can at worst hide
	// the real member's badge, never put their own profile on the real
	// member's nick. (First-claim-wins would need a claim timestamp we
	// don't store — updated_at moves on every publish — and would let a
	// squatter who got there first keep the key forever.)
	byAccount := make(map[string]*row)
	byNickHost := make(map[string]*row)
	claim := func(m map[string]*row, key string, rw *row) {
		if prev, exists := m[key]; exists {
			if prev != nil && prev.UserID != rw.UserID {
				m[key] = nil // contested
			}
			return
		}
		m[key] = rw
	}
	for i := range rows {
		rw := &rows[i]
		if rw.Account != "" {
			claim(byAccount, strings.ToLower(rw.Account), rw)
		}
		claim(byNickHost, nickHostKey(rw.Nick, rw.Host), rw)
	}

	out := make([]LookupMatch, 0, len(items))
	seen := make(map[string]bool)
	for _, it := range items {
		var rw *row
		if it.Account != "" {
			rw = byAccount[strings.ToLower(it.Account)]
		}
		if rw == nil {
			rw = byNickHost[nickHostKey(it.Nick, it.Host)]
		}
		if rw == nil {
			continue
		}
		lk := strings.ToLower(it.Nick)
		if seen[lk] {
			continue
		}
		seen[lk] = true
		out = append(out, LookupMatch{
			Nick:        it.Nick,
			UserID:      rw.UserID,
			Handle:      rw.Handle,
			DisplayName: rw.DisplayName,
			AvatarKey:   rw.AvatarStorageKey,
		})
	}
	return out, nil
}

func nickHostKey(nick, host string) string {
	return strings.ToLower(nick) + "\x00" + host
}
