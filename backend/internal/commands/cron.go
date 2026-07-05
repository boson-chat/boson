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

	// Capture each row's last_checked_at BEFORE the loop mutates it. The
	// demote decision needs the timestamp of the previous successful
	// check, but the loop overwrites s.VerificationLastCheckedAt with
	// `now` before the demote block runs — reading it back afterwards
	// (or scanning `rows`, which holds the same mutated pointers) always
	// compares `now` to itself. Snapshotting here keeps the prior value.
	priorChecked := make(map[string]*time.Time, len(rows))
	for _, s := range rows {
		priorChecked[s.ID.String()] = s.VerificationLastCheckedAt
	}

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
			// Soft miss on a verified row — demote to "lapsed" only if
			// the last successful check is already older than the grace
			// window. `priorChecked` holds the pre-update timestamp; the
			// live s.VerificationLastCheckedAt was just rewritten to now.
			pre := priorChecked[s.ID.String()]
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
