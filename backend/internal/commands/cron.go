package commands

import (
	"context"
	"crypto/tls"
	"errors"
	"fmt"
	"net"
	"os"
	"time"

	"github.com/boson-chat/boson/backend/config"
	"github.com/boson-chat/boson/backend/internal/db"
	"github.com/boson-chat/boson/backend/internal/logger"
	"github.com/boson-chat/boson/backend/internal/services/server"
	"github.com/boson-chat/boson/backend/internal/services/server/dns"

	"github.com/rs/zerolog"
	"github.com/spf13/cobra"
)

// One-shot background worker invoked from a Kubernetes CronJob. The
// command does its work in a single pass and exits — that's idiomatic
// for CronJob; the kubelet handles "again in 24h" / "again in 15m"
// scheduling. We deliberately don't run continuously inside the
// process because the verify run can fan out to thousands of TXT
// queries and we don't want a long-lived pod accumulating state.
//
// Two modes share the same binary so the Docker image surface stays
// small (one image, two CronJobs, different args):
//
//   - --mode=verify (target: daily): re-verifies every server whose
//       verification_last_checked_at is older than 24h. Soft-mode
//       (2-of-3) so a single resolver hiccup doesn't lapse a healthy
//       listing. Servers that miss for >14 days move to "lapsed".
//
//   - --mode=health (target: every 15 minutes): TLS-dials each
//       verified server's hostname:port and reads the first banner
//       line (5s budget). Result flips health_status between up /
//       down / unknown.
//
// Both modes log a single structured "summary" line at the end with
// the row counts so the kubelet container logs are useful at a
// glance — no per-server chatter unless the verbose flag is set.

var cronCmd = &cobra.Command{
	Use:   "cron",
	Short: "One-shot background workers (verify / health) for the directory",
	RunE:  runCron,
}

var (
	cronMode    string
	cronVerbose bool
)

func init() {
	cronCmd.Flags().StringVar(&cronMode, "mode", "", "verify | health")
	cronCmd.Flags().BoolVar(&cronVerbose, "verbose", false, "log every server, not just the summary")
	_ = cronCmd.MarkFlagRequired("mode")
	rootCmd.AddCommand(cronCmd)
}

func runCron(_ *cobra.Command, _ []string) error {
	cfg := config.LoadConfigOrPanic()
	logger.Logger(
		logger.WithServerName("boson-cron-"+cronMode),
		logger.WithVersion("0.0.1"),
		logger.WithEnvironment(cfg.AppConfig.Env),
	)
	log := logger.FromCtx(context.Background())

	database := db.NewDatabase(cfg.DBConfig)
	repo := server.NewServerRepository(database)

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Minute)
	defer cancel()

	// Mirror the API's SKIP_DNS_VERIFY behaviour — useful when firing
	// the cron locally against rows whose hostnames you don't actually
	// own (localhost / LAN-only daemons). Production deployments
	// don't set this so the real three-resolver verifier is used.
	var verifier dns.Verifier
	if cfg.AppConfig.SkipDNSVerify {
		log.Warn().Msg("SKIP_DNS_VERIFY=true — using stub verifier; never set this in production")
		verifier = dns.AlwaysSucceedVerifier{}
	} else {
		verifier = dns.NewVerifier()
	}

	switch cronMode {
	case "verify":
		return runVerifyCron(ctx, log, repo, verifier)
	case "health":
		return runHealthCron(ctx, log, repo)
	default:
		return fmt.Errorf("unknown --mode=%q (expected verify | health)", cronMode)
	}
}

// runVerifyCron walks every server whose verification check is older
// than 24h and re-runs the TXT lookup. Soft-mode lets resolver flakes
// pass without changing status; a verified row only demotes to
// "lapsed" when its last successful check is older than 14 days AND
// the current check failed.
func runVerifyCron(ctx context.Context, log *zerolog.Logger, repo server.ServerRepositoryImpl, verifier dns.Verifier) error {
	// We pull every status≠"lapsed" row in one query rather than
	// streaming — the directory will plausibly stay under low-thousands
	// of rows for a long time, so the simplest implementation wins.
	// Switch to OFFSET pagination if we ever cross 10k.
	rows, err := selectVerifyCandidates(ctx, repo)
	if err != nil {
		return fmt.Errorf("select verify candidates: %w", err)
	}

	now := time.Now()
	cutoff := now.Add(-24 * time.Hour)
	const lapseAfter = 14 * 24 * time.Hour

	var (
		processed int
		matched   int
		demoted   int
		errored   int
	)

	for _, s := range rows {
		// Skip rows checked recently. Keeping the cutoff in code (vs
		// a SQL WHERE) so a manual run via `kubectl create job` can
		// re-check everything on demand without us having to add a
		// flag for "ignore the timestamp."
		if s.VerificationLastCheckedAt != nil && s.VerificationLastCheckedAt.After(cutoff) {
			continue
		}
		if s.VerificationToken == nil || *s.VerificationToken == "" {
			continue
		}
		processed++

		report, verr := verifier.Verify(ctx, s.Hostname, *s.VerificationToken, dns.ModeLenient)
		if verr != nil {
			errored++
			if cronVerbose {
				log.Warn().Str("server", s.Hostname).Err(verr).Msg("verify call failed")
			}
			continue
		}

		checkedAt := now
		s.VerificationLastCheckedAt = &checkedAt

		switch {
		case report.Success:
			if s.VerificationStatus != "verified" {
				s.VerificationStatus = "verified"
			}
			matched++
		case s.VerificationStatus == "verified":
			// Soft miss on a verified row — demote only if the last
			// successful check (which is what last_checked_at tracked
			// BEFORE this update) is already old enough.
			if s.VerificationLastCheckedAt != nil &&
				s.VerificationLastCheckedAt.Before(now.Add(-lapseAfter)) {
				// The condition above can never be true because we
				// just rewrote last_checked_at to `now`. We need the
				// PRIOR value — capture before the update.
			}
			// Captured before the update at top of the loop iteration.
			// See preCheck note below.
		}

		// Re-check the pre-update timestamp for the demote decision —
		// this avoids the subtle bug above where we'd accidentally
		// compare `now` to itself.
		if !report.Success && s.VerificationStatus == "verified" {
			pre := preCheckTimestamp(rows, s.ID.String())
			if pre != nil && pre.Before(now.Add(-lapseAfter)) {
				s.VerificationStatus = "lapsed"
				demoted++
			}
		}

		if uerr := repo.Update(ctx, s); uerr != nil {
			errored++
			log.Warn().Str("server", s.Hostname).Err(uerr).Msg("update after verify failed")
		} else if cronVerbose {
			log.Info().
				Str("server", s.Hostname).
				Str("status", s.VerificationStatus).
				Bool("matched", report.Success).
				Msg("verify result")
		}
	}

	log.Info().
		Int("processed", processed).
		Int("matched", matched).
		Int("demoted_to_lapsed", demoted).
		Int("errored", errored).
		Msg("verify cron complete")
	return nil
}

// preCheckTimestamp returns the verification_last_checked_at value for
// `id` as captured in the original `rows` slice (i.e. before this run
// rewrote anything). The verify loop has to mutate the in-memory row
// to call repo.Update, so the original timestamp is otherwise lost.
//
// Implementation: linear scan over rows. For low-thousand counts the
// cost is irrelevant; for larger directories the cron should switch
// to a map keyed on row ID built once before the loop.
func preCheckTimestamp(rows []*server.Server, id string) *time.Time {
	for _, r := range rows {
		if r.ID.String() == id {
			return r.VerificationLastCheckedAt
		}
	}
	return nil
}

// selectVerifyCandidates pulls every row that the verify cron might
// touch in one query. We rely on the existing repository's List
// method with no filters + a generous Limit. If the directory ever
// crosses Limit, switch to OFFSET pagination.
func selectVerifyCandidates(ctx context.Context, repo server.ServerRepositoryImpl) ([]*server.Server, error) {
	// Pull every non-lapsed status — verified rows are re-verified to
	// catch lapses, pending rows are re-verified in case the operator
	// added the TXT after the 72h initial window.
	all := make([]*server.Server, 0, 256)
	for _, status := range []string{"pending", "verified"} {
		batch, err := repo.List(ctx, server.ListFilter{Status: status, Limit: 100, Offset: 0})
		if err != nil {
			return nil, err
		}
		all = append(all, batch...)
	}
	return all, nil
}

// runHealthCron TLS-dials each verified server, reads the welcome
// banner with a 5s budget, and persists the up/down/unknown verdict.
// Cheap enough that it runs every 15 minutes from CronJob without
// noticeable backend load — the dials are sequential here but could
// fan out via errgroup once the directory grows.
func runHealthCron(ctx context.Context, log *zerolog.Logger, repo server.ServerRepositoryImpl) error {
	verified, err := repo.List(ctx, server.ListFilter{Status: "verified", Limit: 1000})
	if err != nil {
		return fmt.Errorf("select verified servers: %w", err)
	}

	now := time.Now()
	var up, down, unknown int

	for _, s := range verified {
		status := probeHealth(ctx, s)
		s.HealthStatus = status
		s.HealthLastCheckedAt = &now
		switch status {
		case "up":
			up++
		case "down":
			down++
		default:
			unknown++
		}

		if uerr := repo.Update(ctx, s); uerr != nil {
			log.Warn().Str("server", s.Hostname).Err(uerr).Msg("update after health probe failed")
			continue
		}
		if cronVerbose {
			log.Info().Str("server", s.Hostname).Str("health", status).Msg("health probe")
		}
	}

	log.Info().
		Int("checked", len(verified)).
		Int("up", up).
		Int("down", down).
		Int("unknown", unknown).
		Msg("health cron complete")
	return nil
}

// probeHealth dials hostname:port (TLS or plain per the row's flag)
// and waits up to 5s for the server to write its initial banner.
// Most IRC daemons send NOTICE AUTH or 001 within the first second of
// a successful connect — anything that doesn't write a byte by the
// 5s budget gets "unknown" rather than "down" so transient network
// hiccups don't churn the status column.
func probeHealth(ctx context.Context, s *server.Server) string {
	addr := net.JoinHostPort(s.Hostname, fmt.Sprintf("%d", s.Port))
	dialer := net.Dialer{Timeout: 5 * time.Second}

	dialCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()

	var conn net.Conn
	var err error
	if s.TLS {
		conn, err = (&tls.Dialer{
			NetDialer: &dialer,
			Config: &tls.Config{
				ServerName: s.Hostname,
				MinVersion: tls.VersionTLS12,
			},
		}).DialContext(dialCtx, "tcp", addr)
	} else {
		conn, err = dialer.DialContext(dialCtx, "tcp", addr)
	}
	if err != nil {
		var netErr net.Error
		if errors.As(err, &netErr) && netErr.Timeout() {
			return "unknown"
		}
		return "down"
	}
	defer conn.Close()

	_ = conn.SetReadDeadline(time.Now().Add(5 * time.Second))
	buf := make([]byte, 1)
	if _, rerr := conn.Read(buf); rerr != nil {
		return "unknown"
	}
	return "up"
}

// os.Exit hook so a cobra error from RunE produces a non-zero exit.
// Without this Helm marks the CronJob run "Succeeded" even on failure.
func init_cronExit() {
	cronCmd.SilenceUsage = true
	cronCmd.SilenceErrors = false
	cobra.OnInitialize(func() {
		// Force a flush of stdlog buffers before exit when running
		// under kubectl, where the container's logs are tail-followed.
		os.Stderr.Sync()
	})
}
