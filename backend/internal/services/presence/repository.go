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
	// account is given, else the (network, nick, host) fallback.
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
		Scan(&rows).Error
	if err != nil {
		return nil, err
	}

	byAccount := make(map[string]row)
	byNickHost := make(map[string]row)
	for _, rw := range rows {
		if rw.Account != "" {
			byAccount[strings.ToLower(rw.Account)] = rw
		}
		byNickHost[nickHostKey(rw.Nick, rw.Host)] = rw
	}

	out := make([]LookupMatch, 0, len(items))
	seen := make(map[string]bool)
	for _, it := range items {
		rw, ok := row{}, false
		if it.Account != "" {
			rw, ok = byAccount[strings.ToLower(it.Account)]
		}
		if !ok {
			rw, ok = byNickHost[nickHostKey(it.Nick, it.Host)]
		}
		if !ok {
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
