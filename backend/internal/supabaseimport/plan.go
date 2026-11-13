package supabaseimport

import (
	"context"
	"strings"
	"time"

	"github.com/google/uuid"
)

// PasswordMode says what happens to Supabase's bcrypt hashes.
type PasswordMode string

const (
	// PasswordsBcrypt copies the bcrypt hash into password_credentials.
	// Needs the auth service's bcrypt-verify-then-rehash change
	// (docs/auth-service-bcrypt-import.patch); without it those logins fail.
	PasswordsBcrypt PasswordMode = "bcrypt"
	// PasswordsNone imports accounts without a password; users set one
	// through the reset email (`--send-reset-emails`).
	PasswordsNone PasswordMode = "none"
)

// Action is what the import does with one Supabase account.
type Action string

const (
	ActionCreate       Action = "create"        // new auth user + mapping
	ActionLinkExisting Action = "link_existing" // auth user with that email already exists (verified): map to it
	ActionAlreadyDone  Action = "already_mapped"
	ActionSkip         Action = "skip"
	ActionConflict     Action = "conflict" // needs a human
)

// Options steer the plan.
type Options struct {
	Passwords PasswordMode
	// SkipUnverified leaves out accounts whose email was never confirmed.
	// Default: import them unverified (they verify on first login).
	SkipUnverified bool
	// LinkExistingVerified maps a Supabase account onto an auth account that
	// already has the same, verified, email instead of reporting a conflict.
	LinkExistingVerified bool
	Now                  time.Time
}

// ExistingAuthUser is an auth-service account found by email.
type ExistingAuthUser struct {
	ID            string
	Username      string
	EmailVerified bool
}

// Planned is the decision for one Supabase account.
type Planned struct {
	Supabase       SupabaseUser
	Action         Action
	AuthUserID     string // set for create (pre-generated), link_existing, already_mapped
	Username       string
	UsernameSource string // boson_handle | metadata:<key> | email | fallback
	Renamed        bool   // the preferred name was taken or invalid and had to change
	EmailVerified  bool
	PasswordHash   string // bcrypt hash to store, "" for none
	Disabled       bool   // banned in Supabase
	Note           string
}

// Inputs is everything the planner looks at besides the export.
type Inputs struct {
	// BosonHandles: users.handle by boson user id (= Supabase id).
	BosonHandles map[uuid.UUID]string
	// Mapped: supabase id → auth user id already in auth_identities.
	Mapped map[uuid.UUID]string
	// TakenUsernames: folded usernames already in the auth service.
	TakenUsernames map[string]struct{}
	// ExistingByEmail: auth users by lower-cased email.
	ExistingByEmail map[string]ExistingAuthUser
	// NewID makes auth user ids (usr_<ULID>).
	NewID func() string
}

var metadataNameKeys = []string{"handle", "username", "user_name", "preferred_username", "nickname", "nick", "name", "full_name"}

// Plan decides what to do with every account. Pure: no I/O.
func Plan(users []SupabaseUser, in Inputs, opt Options) []Planned {
	taken := make(map[string]struct{}, len(in.TakenUsernames)+len(users))
	for k := range in.TakenUsernames {
		taken[k] = struct{}{}
	}
	seenEmail := map[string]uuid.UUID{}
	out := make([]Planned, 0, len(users))
	for _, u := range users {
		p := Planned{Supabase: u, EmailVerified: u.EmailConfirmedAt != nil}
		email := strings.ToLower(u.Email)
		switch {
		case in.Mapped[u.ID] != "":
			p.Action, p.AuthUserID, p.Note = ActionAlreadyDone, in.Mapped[u.ID], "mapping exists in auth_identities"
		case u.DeletedAt != nil:
			p.Action, p.Note = ActionSkip, "deleted in Supabase"
		case u.IsAnonymous:
			p.Action, p.Note = ActionSkip, "anonymous Supabase user"
		case email == "" || !strings.Contains(email, "@"):
			p.Action, p.Note = ActionConflict, "no email address (phone-only?)"
		case !p.EmailVerified && opt.SkipUnverified:
			p.Action, p.Note = ActionSkip, "email never confirmed (--skip-unverified)"
		case seenEmail[email] != uuid.Nil:
			p.Action, p.Note = ActionConflict, "same email as Supabase user "+seenEmail[email].String()
		}
		if p.Action != "" {
			out = append(out, p)
			continue
		}
		seenEmail[email] = u.ID

		if ex, ok := in.ExistingByEmail[email]; ok {
			switch {
			case ex.EmailVerified && opt.LinkExistingVerified:
				p.Action, p.AuthUserID, p.Username = ActionLinkExisting, ex.ID, ex.Username
				p.Note = "auth account with this verified email already exists; mapped to it"
			case ex.EmailVerified:
				p.Action, p.AuthUserID = ActionConflict, ex.ID
				p.Note = "auth account " + ex.Username + " already has this (verified) email; rerun with --link-existing-verified to map to it"
			default:
				p.Action, p.AuthUserID = ActionConflict, ex.ID
				p.Note = "auth account " + ex.Username + " already has this email, unverified: possibly someone else's sign-up; resolve by hand"
			}
			out = append(out, p)
			continue
		}

		preferred, source := preferredName(u, in.BosonHandles)
		name := sanitizeNick(preferred)
		if name == "" {
			name, source = "user", "fallback"
		}
		p.Renamed = name != preferred
		final := uniqueNick(name, taken)
		if final != name {
			p.Renamed = true
			p.Note = "username " + name + " taken; using " + final
		}
		taken[foldNick(final)] = struct{}{}
		p.Username, p.UsernameSource = final, source
		p.Action = ActionCreate
		p.AuthUserID = in.NewID()
		if opt.Passwords == PasswordsBcrypt && isBcrypt(u.EncryptedPassword) {
			p.PasswordHash = u.EncryptedPassword
		}
		if p.PasswordHash == "" {
			p.Note = joinNote(p.Note, "no password imported: needs a reset email")
		}
		if u.BannedUntil != nil && u.BannedUntil.After(opt.Now) {
			p.Disabled = true
			p.Note = joinNote(p.Note, "banned in Supabase: imported disabled")
		}
		out = append(out, p)
	}
	return out
}

func preferredName(u SupabaseUser, handles map[uuid.UUID]string) (string, string) {
	if h := strings.TrimSpace(handles[u.ID]); h != "" {
		return h, "boson_handle"
	}
	for _, k := range metadataNameKeys {
		if v, ok := u.Metadata[k].(string); ok && strings.TrimSpace(v) != "" {
			return strings.TrimSpace(v), "metadata:" + k
		}
	}
	local, _, _ := strings.Cut(u.Email, "@")
	return local, "email"
}

func isBcrypt(h string) bool {
	return len(h) == 60 && (strings.HasPrefix(h, "$2a$") || strings.HasPrefix(h, "$2b$") || strings.HasPrefix(h, "$2y$"))
}

func joinNote(a, b string) string {
	if a == "" {
		return b
	}
	return a + "; " + b
}

// Summary counts planned actions.
func Summary(plan []Planned) map[Action]int {
	m := map[Action]int{}
	for _, p := range plan {
		m[p.Action]++
	}
	return m
}

// AuthStore writes to the auth service's database.
type AuthStore interface {
	TakenUsernames(ctx context.Context) (map[string]struct{}, error)
	ExistingByEmail(ctx context.Context) (map[string]ExistingAuthUser, error)
	CreateUser(ctx context.Context, p Planned) error
}

// BosonStore reads handles from and writes mappings to boson's database.
type BosonStore interface {
	Handles(ctx context.Context) (map[uuid.UUID]string, error)
	Mapped(ctx context.Context) (map[uuid.UUID]string, error)
	Link(ctx context.Context, authUserID string, supabaseID uuid.UUID) error
}
