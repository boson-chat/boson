package supabaseimport

import (
	"context"
	"encoding/csv"
	"fmt"
	"io"
	"os"
	"strconv"
	"time"
)

// RunOptions configure Run.
type RunOptions struct {
	Options
	DryRun bool
	// MappingOut, when set, gets one CSV row per Supabase account.
	MappingOut string
	// Reset, when set, sends a password-reset email to every account
	// created without a password (and, with ResetAll, every created one).
	Reset    *ResetMailer
	ResetAll bool
	Log      io.Writer
}

// Result is what Run did.
type Result struct {
	Plan    []Planned
	Created int
	Linked  int
	Resets  int
	Failed  int
}

// Run plans the import, applies it unless DryRun, and writes the mapping
// file. Safe to rerun: accounts already in auth_identities are skipped.
func Run(ctx context.Context, users []SupabaseUser, auth AuthStore, boson BosonStore, opt RunOptions) (*Result, error) {
	logf := func(format string, a ...any) {
		if opt.Log != nil {
			fmt.Fprintf(opt.Log, format+"\n", a...)
		}
	}
	if opt.Now.IsZero() {
		opt.Now = time.Now()
	}
	handles, err := boson.Handles(ctx)
	if err != nil {
		return nil, fmt.Errorf("read boson handles: %w", err)
	}
	mapped, err := boson.Mapped(ctx)
	if err != nil {
		return nil, fmt.Errorf("read auth_identities: %w", err)
	}
	taken, err := auth.TakenUsernames(ctx)
	if err != nil {
		return nil, fmt.Errorf("read auth usernames: %w", err)
	}
	existing, err := auth.ExistingByEmail(ctx)
	if err != nil {
		return nil, fmt.Errorf("read auth emails: %w", err)
	}
	plan := Plan(users, Inputs{
		BosonHandles: handles, Mapped: mapped, TakenUsernames: taken, ExistingByEmail: existing, NewID: NewAuthUserID,
	}, opt.Options)
	res := &Result{Plan: plan}

	for i := range plan {
		p := &plan[i]
		if opt.DryRun {
			if p.Action == ActionCreate {
				p.AuthUserID = "" // not created; the id would differ on the real run
			}
			continue
		}
		switch p.Action {
		case ActionCreate:
			if err := auth.CreateUser(ctx, *p); err != nil {
				p.Action, p.Note = ActionConflict, joinNote(p.Note, "create failed: "+err.Error())
				res.Failed++
				continue
			}
			if err := boson.Link(ctx, p.AuthUserID, p.Supabase.ID); err != nil {
				// The auth user exists but isn't mapped: a rerun can't
				// recreate it (email taken) — report loudly.
				p.Action, p.Note = ActionConflict, joinNote(p.Note, "auth user created but mapping failed: "+err.Error())
				res.Failed++
				continue
			}
			res.Created++
		case ActionLinkExisting:
			if err := boson.Link(ctx, p.AuthUserID, p.Supabase.ID); err != nil {
				p.Action, p.Note = ActionConflict, joinNote(p.Note, "mapping failed: "+err.Error())
				res.Failed++
				continue
			}
			res.Linked++
		}
	}

	if opt.Reset != nil && !opt.DryRun {
		first := true
		for _, p := range plan {
			if p.Action != ActionCreate || p.Disabled || (p.PasswordHash != "" && !opt.ResetAll) {
				continue
			}
			if !first && opt.Reset.Interval > 0 {
				select {
				case <-time.After(opt.Reset.Interval):
				case <-ctx.Done():
					return res, ctx.Err()
				}
			}
			first = false
			if err := opt.Reset.Send(ctx, p.Supabase.Email); err != nil {
				logf("reset email for %s failed: %v", p.Supabase.ID, err)
				res.Failed++
				continue
			}
			res.Resets++
		}
	}

	if opt.MappingOut != "" {
		if err := writeMapping(opt.MappingOut, plan); err != nil {
			return res, err
		}
	}
	return res, nil
}

func writeMapping(path string, plan []Planned) error {
	f, err := os.OpenFile(path, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o600)
	if err != nil {
		return err
	}
	w := csv.NewWriter(f)
	_ = w.Write([]string{"supabase_id", "auth_user_id", "action", "username", "username_source", "renamed", "email", "email_verified", "password_imported", "disabled", "note"})
	for _, p := range plan {
		_ = w.Write([]string{
			p.Supabase.ID.String(), p.AuthUserID, string(p.Action), p.Username, p.UsernameSource,
			strconv.FormatBool(p.Renamed), p.Supabase.Email, strconv.FormatBool(p.EmailVerified),
			strconv.FormatBool(p.PasswordHash != ""), strconv.FormatBool(p.Disabled), p.Note,
		})
	}
	w.Flush()
	if err := w.Error(); err != nil {
		f.Close()
		return err
	}
	return f.Close()
}
