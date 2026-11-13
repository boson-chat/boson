package commands

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"os"
	"os/signal"
	"sort"
	"time"

	"github.com/boson-chat/boson/backend/config"
	internaldb "github.com/boson-chat/boson/backend/internal/db"
	"github.com/boson-chat/boson/backend/internal/services/authidentity"
	"github.com/boson-chat/boson/backend/internal/supabaseimport"

	_ "github.com/lib/pq" // database/sql driver "postgres" for the auth DB
	"github.com/spf13/cobra"
)

var importSupabaseFlags struct {
	export               string
	authDB               string
	passwords            string
	dryRun               bool
	mappingOut           string
	skipUnverified       bool
	linkExistingVerified bool
	sendResets           bool
	resetAll             bool
	authURL              string
	resetInterval        time.Duration
}

var importSupabaseCmd = &cobra.Command{
	Use:   "import-supabase-users",
	Short: "Import Supabase Auth accounts into the boson auth service and map their ids",
	Long: `Reads a Supabase auth.users export, creates the accounts in the boson auth
service's database (usernames from boson handles, else metadata, else the
email local part, made IRC-valid and unique), keeps email-verified status,
and records supabase_id -> auth user id in boson's auth_identities table so
existing boson data keeps resolving. Safe to rerun.

Boson's database comes from the usual DB* env / config. See
docs/migration-supabase-to-auth.md.`,
	RunE: func(cmd *cobra.Command, _ []string) error {
		f := importSupabaseFlags
		mode := supabaseimport.PasswordMode(f.passwords)
		if mode != supabaseimport.PasswordsBcrypt && mode != supabaseimport.PasswordsNone {
			return fmt.Errorf("--passwords must be bcrypt or none")
		}
		if f.export == "" || f.authDB == "" {
			return errors.New("--export and --auth-db are required")
		}
		if f.sendResets && f.authURL == "" {
			return errors.New("--send-reset-emails needs --auth-url")
		}
		users, err := supabaseimport.ReadExport(f.export)
		if err != nil {
			return err
		}

		ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt)
		defer stop()

		authDB, err := sql.Open("postgres", f.authDB)
		if err != nil {
			return err
		}
		defer authDB.Close()
		if err := authDB.PingContext(ctx); err != nil {
			return fmt.Errorf("auth db: %w", err)
		}
		cfg := config.LoadConfigOrPanic()
		bdb := internaldb.NewDatabase(cfg.DBConfig)

		opt := supabaseimport.RunOptions{
			Options: supabaseimport.Options{
				Passwords: mode, SkipUnverified: f.skipUnverified, LinkExistingVerified: f.linkExistingVerified,
			},
			DryRun: f.dryRun, MappingOut: f.mappingOut, ResetAll: f.resetAll, Log: cmd.ErrOrStderr(),
		}
		if f.sendResets {
			opt.Reset = &supabaseimport.ResetMailer{BaseURL: f.authURL, Interval: f.resetInterval}
		}
		res, err := supabaseimport.Run(ctx,
			users,
			supabaseimport.SQLAuthStore{DB: authDB},
			supabaseimport.GormBosonStore{DB: bdb, Identities: authidentity.NewService(bdb)},
			opt)
		if res != nil {
			printImportSummary(cmd, res, f.dryRun)
		}
		if err != nil {
			return err
		}
		if res.Failed > 0 {
			return fmt.Errorf("%d accounts failed; see the mapping file", res.Failed)
		}
		return nil
	},
}

func printImportSummary(cmd *cobra.Command, res *supabaseimport.Result, dry bool) {
	out := cmd.OutOrStdout()
	if dry {
		fmt.Fprintln(out, "DRY RUN: nothing was written.")
	}
	counts := supabaseimport.Summary(res.Plan)
	keys := make([]string, 0, len(counts))
	for k := range counts {
		keys = append(keys, string(k))
	}
	sort.Strings(keys)
	fmt.Fprintf(out, "%d Supabase accounts:", len(res.Plan))
	for _, k := range keys {
		fmt.Fprintf(out, " %s=%d", k, counts[supabaseimport.Action(k)])
	}
	fmt.Fprintln(out)
	renamed, noPassword, unverified := 0, 0, 0
	for _, p := range res.Plan {
		if p.Action != supabaseimport.ActionCreate {
			continue
		}
		if p.Renamed {
			renamed++
		}
		if p.PasswordHash == "" {
			noPassword++
		}
		if !p.EmailVerified {
			unverified++
		}
	}
	fmt.Fprintf(out, "to create: %d renamed username, %d without password, %d unverified email\n", renamed, noPassword, unverified)
	if !dry {
		fmt.Fprintf(out, "created=%d linked=%d reset_emails=%d failed=%d\n", res.Created, res.Linked, res.Resets, res.Failed)
	}
	for _, p := range res.Plan {
		if p.Action == supabaseimport.ActionConflict {
			fmt.Fprintf(out, "CONFLICT %s %s: %s\n", p.Supabase.ID, p.Supabase.Email, p.Note)
		}
	}
}

func init() {
	f := &importSupabaseFlags
	c := importSupabaseCmd
	c.Flags().StringVar(&f.export, "export", "", "Supabase auth.users export (.csv with header, .json, .jsonl)")
	c.Flags().StringVar(&f.authDB, "auth-db", os.Getenv("AUTH_DATABASE_URL"), "auth service Postgres URL (default $AUTH_DATABASE_URL)")
	c.Flags().StringVar(&f.passwords, "passwords", "bcrypt", "bcrypt: copy Supabase bcrypt hashes (needs the auth-service bcrypt patch); none: import without passwords")
	c.Flags().BoolVar(&f.dryRun, "dry-run", false, "plan only: print and write the mapping file, change nothing")
	c.Flags().StringVar(&f.mappingOut, "mapping-out", "supabase-import-mapping.csv", "CSV of supabase_id -> auth_user_id and every decision ('' to skip)")
	c.Flags().BoolVar(&f.skipUnverified, "skip-unverified", false, "leave out accounts whose email was never confirmed")
	c.Flags().BoolVar(&f.linkExistingVerified, "link-existing-verified", false, "map onto an auth account that already has the same verified email instead of reporting a conflict")
	c.Flags().BoolVar(&f.sendResets, "send-reset-emails", false, "after importing, send a password-reset email to every account created without a password")
	c.Flags().BoolVar(&f.resetAll, "reset-all", false, "with --send-reset-emails: also email accounts whose bcrypt hash was imported")
	c.Flags().StringVar(&f.authURL, "auth-url", "", "auth service public URL for reset emails, e.g. https://auth.boson.chat")
	c.Flags().DurationVar(&f.resetInterval, "reset-interval", 7*time.Second, "pause between reset emails (auth rate limit: 10/min per IP by default)")
	rootCmd.AddCommand(c)
}
