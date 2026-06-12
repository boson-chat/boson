package nickclaim

import (
	"context"
	"crypto/rand"
	"encoding/base32"
	"errors"
	"strings"
	"time"

	"github.com/boson-chat/boson/backend/internal/db"

	"github.com/google/uuid"
	"gorm.io/gorm"
)

var (
	ErrNotFound = errors.New("nick claim not found")
	// ErrStaleStatus is returned when a state-transition method is
	// called on a row whose current status doesn't allow the
	// transition (e.g. MarkConsumed on a 'pending' row).
	ErrStaleStatus = errors.New("nick claim is not in the expected status")
)

type RepositoryImpl interface {
	// Create mints a new pending claim. Generates the short_token
	// internally — caller never sees the random bytes. Retries on
	// the (cosmically rare) short_token uniqueness collision.
	Create(ctx context.Context, userID uuid.UUID, serverID, accountNick string) (*NickClaim, error)

	// FindByID returns the claim if it belongs to userID. Returns
	// ErrNotFound for both "row doesn't exist" and "row exists but
	// belongs to another user" — same external behaviour so the
	// handler can't be used as an existence oracle.
	FindByID(ctx context.Context, id, userID uuid.UUID) (*NickClaim, error)

	// FindByShortToken is the IMAP worker's lookup path. NO
	// userID filter — the worker has no user context, it only has
	// the recipient address. The short_token's uniqueness IS the
	// authentication (a worker that processes mail for the wrong
	// short_token simply finds no row).
	FindByShortToken(ctx context.Context, token string) (*NickClaim, error)

	// MarkCaptured stores the captured code + IMAP UID and flips
	// status to 'captured'. Only succeeds when current status is
	// 'pending'; otherwise returns ErrStaleStatus (e.g. duplicate
	// inbound mail after a worker reconnect).
	MarkCaptured(ctx context.Context, id uuid.UUID, code, mailUID string) error

	// MarkConsumed flips a 'captured' row to 'consumed' and stamps
	// consumed_at. Caller is also user-scoped here; the userID
	// guards against a leaked id.
	MarkConsumed(ctx context.Context, id, userID uuid.UUID) error

	// ExpireBefore moves any 'pending' row whose expires_at is
	// before t to 'expired'. Returns the number of rows moved so
	// the caller can log batch sizes.
	ExpireBefore(ctx context.Context, t time.Time) (int64, error)

	// CountSince counts the rows this user created since t. Used by
	// the handler's rate-limit (e.g. 5 per hour).
	CountSince(ctx context.Context, userID uuid.UUID, since time.Time) (int64, error)

	// MailUIDCaptured reports whether any row has already recorded
	// this POP3 UIDL — used by the worker to skip re-processing a
	// message it captured on a previous tick (we leave matched
	// emails in the inbox for audit instead of DELE'ing them).
	MailUIDCaptured(ctx context.Context, mailUID string) (bool, error)

	// FindNewestPendingByNick returns the most-recent 'pending'
	// claim whose account_nick matches. Used by the worker when the
	// recipient address has been collapsed by a catch-all and the
	// short_token isn't recoverable from headers — we route by the
	// nick mentioned in the email body instead. Returns ErrNotFound
	// if no pending claim exists for that nick (case-insensitive).
	FindNewestPendingByNick(ctx context.Context, accountNick string) (*NickClaim, error)
}

type Repository struct {
	db  *db.DB
	now func() time.Time
}

func NewRepository(database *db.DB) RepositoryImpl {
	return &Repository{db: database, now: time.Now}
}

// NewRepositoryWithClock is the test seam — production callers use
// NewRepository which pins to wall-clock time.
func NewRepositoryWithClock(database *db.DB, now func() time.Time) RepositoryImpl {
	return &Repository{db: database, now: now}
}

// shortTokenLength is the printable length of short_token after
// base32 encoding. 8 base32 chars = 5 bytes of entropy = 2^40
// possibilities — overkill for a 30-min-TTL discriminator that
// only has to be unique among the user's current in-flight claims,
// but cheap and matches the "looks like a short id" feel of the
// recipient address.
const shortTokenLength = 8

// shortTokenAlphabet is the lowercase base32 alphabet (RFC 4648
// crockford-ish) minus padding. Easy to type if a user ever has to
// read one out loud, even though normally they never see it.
var shortTokenAlphabet = base32.StdEncoding.WithPadding(base32.NoPadding)

func newShortToken() (string, error) {
	// 5 random bytes encode to exactly 8 base32 chars.
	buf := make([]byte, 5)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	return strings.ToLower(shortTokenAlphabet.EncodeToString(buf)), nil
}

func (r *Repository) Create(ctx context.Context, userID uuid.UUID, serverID, accountNick string) (*NickClaim, error) {
	now := r.now().UTC()
	for attempt := 0; attempt < 5; attempt++ {
		token, err := newShortToken()
		if err != nil {
			return nil, err
		}
		claim := &NickClaim{
			ID:          uuid.New(),
			UserID:      userID,
			ShortToken:  token,
			ServerID:    serverID,
			AccountNick: accountNick,
			Status:      StatusPending,
			CreatedAt:   now,
			ExpiresAt:   now.Add(TTL),
		}
		err = r.db.DB.WithContext(ctx).Create(claim).Error
		if err == nil {
			return claim, nil
		}
		// Retry on unique-violation against short_token. GORM
		// surfaces this as the driver's pgconn error wrapped in a
		// "*pgconn.PgError" — we sniff via the message rather than
		// importing pgconn here, since that's the existing pattern
		// in this codebase (user/service.go does the same).
		if !strings.Contains(strings.ToLower(err.Error()), "short_token") {
			return nil, err
		}
		// Loop and mint a new token.
	}
	return nil, errors.New("nick claim: short_token collision after 5 attempts")
}

func (r *Repository) FindByID(ctx context.Context, id, userID uuid.UUID) (*NickClaim, error) {
	var c NickClaim
	err := r.db.DB.WithContext(ctx).
		Where("id = ? AND user_id = ?", id, userID).
		First(&c).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	return &c, nil
}

func (r *Repository) FindByShortToken(ctx context.Context, token string) (*NickClaim, error) {
	var c NickClaim
	err := r.db.DB.WithContext(ctx).
		Where("short_token = ?", token).
		First(&c).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	return &c, nil
}

func (r *Repository) MarkCaptured(ctx context.Context, id uuid.UUID, code, mailUID string) error {
	res := r.db.DB.WithContext(ctx).Model(&NickClaim{}).
		Where("id = ? AND status = ?", id, StatusPending).
		Updates(map[string]any{
			"status":   StatusCaptured,
			"code":     code,
			"mail_uid": mailUID,
		})
	if res.Error != nil {
		return res.Error
	}
	if res.RowsAffected == 0 {
		// Either the id doesn't exist or the status was already
		// captured/consumed/expired. Both look the same from the
		// IMAP worker's perspective — log and skip.
		return ErrStaleStatus
	}
	return nil
}

func (r *Repository) MarkConsumed(ctx context.Context, id, userID uuid.UUID) error {
	now := r.now().UTC()
	res := r.db.DB.WithContext(ctx).Model(&NickClaim{}).
		Where("id = ? AND user_id = ? AND status = ?", id, userID, StatusCaptured).
		Updates(map[string]any{
			"status":      StatusConsumed,
			"consumed_at": now,
		})
	if res.Error != nil {
		return res.Error
	}
	if res.RowsAffected == 0 {
		return ErrStaleStatus
	}
	return nil
}

func (r *Repository) ExpireBefore(ctx context.Context, t time.Time) (int64, error) {
	res := r.db.DB.WithContext(ctx).Model(&NickClaim{}).
		Where("status = ? AND expires_at < ?", StatusPending, t).
		Update("status", StatusExpired)
	return res.RowsAffected, res.Error
}

func (r *Repository) CountSince(ctx context.Context, userID uuid.UUID, since time.Time) (int64, error) {
	var n int64
	err := r.db.DB.WithContext(ctx).Model(&NickClaim{}).
		Where("user_id = ? AND created_at >= ?", userID, since).
		Count(&n).Error
	return n, err
}

func (r *Repository) MailUIDCaptured(ctx context.Context, mailUID string) (bool, error) {
	if mailUID == "" {
		return false, nil
	}
	var n int64
	err := r.db.DB.WithContext(ctx).Model(&NickClaim{}).
		Where("mail_uid = ?", mailUID).
		Count(&n).Error
	return n > 0, err
}

func (r *Repository) FindNewestPendingByNick(ctx context.Context, accountNick string) (*NickClaim, error) {
	if accountNick == "" {
		return nil, ErrNotFound
	}
	var c NickClaim
	err := r.db.DB.WithContext(ctx).
		Where("LOWER(account_nick) = LOWER(?) AND status = ?", accountNick, StatusPending).
		Order("created_at DESC").
		First(&c).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	return &c, nil
}
