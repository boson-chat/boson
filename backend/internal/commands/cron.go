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

	"github.com/google/uuid"
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

	// A cobra error from RunE must produce a non-zero exit so Helm marks
	// the CronJob run failed instead of "Succeeded". SilenceErrors keeps
	// cobra from also printing the error (we log it ourselves).
	cronCmd.SilenceUsage = true
	cronCmd.SilenceErrors = false
	cobra.OnInitialize(func() {
		// Flush stdlog buffers before exit when running under kubectl,
		// where the container's logs are tail-followed.
		_ = os.Stderr.Sync()
	})
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
	// own (localhost / LAN-only daemons). The bypass only exists in
	// `boson_dev` builds; in a production binary SelectVerifier always
	// returns the real three-resolver verifier (see dns/bypass_prod.go).
	verifier := dns.SelectVerifier(cfg.AppConfig.SkipDNSVerify)

	switch cronMode {
	case "verify":
		return runVerifyCron(ctx, log, repo, verifier)
	case "health":
		return runHealthCron(ctx, log, repo)
	default:
		return fmt.Errorf("unknown --mode=%q (expected verify | health)", cronMode)
	}
}

// cronBatchSize bounds how many rows each cron holds in memory at a
// time. Rows are paged by id (keyset), so the full directory is covered
// regardless of size, and each row is read shortly before it's written.
const cronBatchSize = 200

// forEachServer pages through every server whose verification_status
// is in statuses — NSFW included, no limit clamp — and calls fn on each.
// Keyset pagination by id keeps the walk stable while other writers
// (owners editing profiles, the API's /verify) touch rows mid-run.
func forEachServer(ctx context.Context, repo server.ServerRepositoryImpl, statuses []string, fn func(*server.Server)) error {
	after := uuid.Nil
	for {
		batch, err := repo.ListBatchForCron(ctx, statuses, after, cronBatchSize)
		if err != nil {
			return err
		}
		for _, s := range batch {
			if err := ctx.Err(); err != nil {
				return err
			}
			fn(s)
		}
		if len(batch) < cronBatchSize {
			return nil
		}
		after = batch[len(batch)-1].ID
	}
}

// runVerifyCron walks every server whose verification check is older
// than 24h and re-runs the TXT lookup. Soft-mode lets resolver flakes
// pass without changing status; a verified row only demotes to
// "lapsed" when its last successful check is older than 14 days AND
// the current check failed.
func runVerifyCron(ctx context.Context, log *zerolog.Logger, repo server.ServerRepositoryImpl, verifier dns.Verifier) error {
	now := time.Now()
	cutoff := now.Add(-24 * time.Hour)
	const lapseAfter = 14 * 24 * time.Hour

	var (
		processed int
		matched   int
		demoted   int
		skipped   int
		errored   int
	)

	// Pull every non-lapsed status — verified rows are re-verified to
	// catch lapses, pending rows are re-verified in case the operator
	// added the TXT after the 72h initial window.
	err := forEachServer(ctx, repo, []string{"pending", "verified"}, func(s *server.Server) {
		// Skip rows checked recently. Keeping the cutoff in code (vs
		// a SQL WHERE) so a manual run via `kubectl create job` can
		// re-check everything on demand without us having to add a
		// flag for "ignore the timestamp."
		if s.VerificationLastCheckedAt != nil && s.VerificationLastCheckedAt.After(cutoff) {
			return
		}
		if s.VerificationToken == nil || *s.VerificationToken == "" {
			return
		}
		processed++

		report, verr := verifier.Verify(ctx, s.Hostname, *s.VerificationToken, dns.ModeLenient)
		if verr != nil {
			errored++
			if cronVerbose {
				log.Warn().Str("server", s.Hostname).Err(verr).Msg("verify call failed")
			}
			return
		}

		status := s.VerificationStatus
		switch {
		case report.Success:
			status = "verified"
			matched++
		case s.VerificationStatus == "verified":
			// Soft miss on a verified row — demote to "lapsed" only if
			// the last successful check is already older than the grace
			// window.
			if pre := s.VerificationLastCheckedAt; pre != nil && pre.Before(now.Add(-lapseAfter)) {
				status = "lapsed"
				demoted++
			}
		}

		// Column-scoped and guarded on the token we just checked: if the
		// owner regenerated mid-run, the verdict is for a stale token and
		// is dropped rather than clobbering the fresh pending state.
		applied, uerr := repo.RecordVerifyResult(ctx, s.ID, *s.VerificationToken, status, now)
		switch {
		case uerr != nil:
			errored++
			log.Warn().Str("server", s.Hostname).Err(uerr).Msg("update after verify failed")
		case !applied:
			skipped++
			if cronVerbose {
				log.Info().Str("server", s.Hostname).Msg("token changed during verify; result dropped")
			}
		case cronVerbose:
			log.Info().
				Str("server", s.Hostname).
				Str("status", status).
				Bool("matched", report.Success).
				Msg("verify result")
		}
	})
	if err != nil {
		return fmt.Errorf("walk verify candidates: %w", err)
	}

	log.Info().
		Int("processed", processed).
		Int("matched", matched).
		Int("demoted_to_lapsed", demoted).
		Int("skipped_token_changed", skipped).
		Int("errored", errored).
		Msg("verify cron complete")
	return nil
}

// runHealthCron TLS-dials each verified server, reads the welcome
// banner with a 5s budget, and persists the up/down/unknown verdict.
// Cheap enough that it runs every 15 minutes from CronJob without
// noticeable backend load — the dials are sequential here but could
// fan out via errgroup once the directory grows.
func runHealthCron(ctx context.Context, log *zerolog.Logger, repo server.ServerRepositoryImpl) error {
	return runHealthCronWith(ctx, log, repo, probeHealth)
}

// runHealthCronWith is runHealthCron with the probe injected so tests
// can exercise the walk + write path without dialing the network.
func runHealthCronWith(ctx context.Context, log *zerolog.Logger, repo server.ServerRepositoryImpl, probe func(context.Context, *server.Server) string) error {
	var checked, up, down, unknown int

	err := forEachServer(ctx, repo, []string{"verified"}, func(s *server.Server) {
		status := probe(ctx, s)
		checked++
		switch status {
		case "up":
			up++
		case "down":
			down++
		default:
			unknown++
		}

		if uerr := repo.RecordHealthResult(ctx, s.ID, status, time.Now()); uerr != nil {
			log.Warn().Str("server", s.Hostname).Err(uerr).Msg("update after health probe failed")
			return
		}
		if cronVerbose {
			log.Info().Str("server", s.Hostname).Str("health", status).Msg("health probe")
		}
	})
	if err != nil {
		return fmt.Errorf("walk verified servers: %w", err)
	}

	log.Info().
		Int("checked", checked).
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
