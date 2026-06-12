package nickclaim

import (
	"context"
	"errors"
	"fmt"
	"io"
	"strings"
	"time"

	"github.com/boson-chat/boson/backend/internal/logger"

	"github.com/emersion/go-message"
	"github.com/knadh/go-pop3"
)

// WorkerConfig describes how the POP3 worker connects to the
// inbound mail server. When Host is empty the worker no-ops at
// startup — local-dev runs that don't care about email don't need
// the mail container.
//
// POP3 (vs IMAP) was picked deliberately:
//   - mailpit (our dev mail receiver) doesn't speak IMAP
//   - PurelyMail (production) speaks both; POP3 keeps a single
//     code path
//   - For our use case (~1 email per claim, latency tolerant to ~5s)
//     IMAP-IDLE's push delivery isn't worth the extra protocol
//     complexity or the dev-prod asymmetry
//
// Disposition policy:
//   - matched (we wrote a code to a nick_claims row): the message
//     is LEFT on the server as an audit artefact. The next tick
//     short-circuits via MailUIDCaptured(uidl) before RETR, so we
//     don't reparse it.
//   - unmatched (garbage / unknown token / no fuzzy hit): DELE'd
//     so the inbox doesn't accumulate unrelated mail.
type WorkerConfig struct {
	Host          string
	Port          int
	User          string
	Password      string
	UseTLS        bool          // true = TLS on connect (port 995 in prod). false = plaintext (mailpit dev).
	PollInterval  time.Duration // between full DRAINs. Default 5s.
	SweepInterval time.Duration // TTL sweeper cadence. Default 5min.
}

const (
	defaultPollInterval  = 5 * time.Second
	defaultSweepInterval = 5 * time.Minute
)

// Worker connects to a POP3 server on an interval, downloads all
// messages waiting in the mailbox, parses the recipient address
// out of each one (`reg-<userid>-<short>@<domain>`), extracts the
// confirmation code from the body, writes it back to the matching
// nick_claims row via the repository, and DELEs the message.
//
// Started as a co-resident goroutine in StartServerWithContext;
// shares the parent ctx so SIGTERM propagates cleanly.
type Worker struct {
	cfg  WorkerConfig
	repo RepositoryImpl
}

func NewWorker(cfg WorkerConfig, repo RepositoryImpl) *Worker {
	if cfg.PollInterval == 0 {
		cfg.PollInterval = defaultPollInterval
	}
	if cfg.SweepInterval == 0 {
		cfg.SweepInterval = defaultSweepInterval
	}
	return &Worker{cfg: cfg, repo: repo}
}

// Run blocks until ctx is cancelled. Connects + drains + disconnects
// on each tick — POP3 sessions are usually exclusive (one client at
// a time per mailbox), so the short-lived session model avoids
// holding a connection between polls. Errors during a session are
// logged but not fatal: the next tick reconnects.
func (w *Worker) Run(ctx context.Context) {
	log := logger.FromCtx(ctx)
	if w.cfg.Host == "" {
		log.Info().Msg("nickclaim: POP3 worker disabled (PURELYMAIL_POP3_HOST is empty)")
		return
	}
	log.Info().
		Str("host", w.cfg.Host).
		Int("port", w.cfg.Port).
		Bool("tls", w.cfg.UseTLS).
		Dur("poll", w.cfg.PollInterval).
		Msg("nickclaim: POP3 worker starting")

	go w.sweepLoop(ctx)

	ticker := time.NewTicker(w.cfg.PollInterval)
	defer ticker.Stop()

	// Tick once immediately on startup — drains anything that
	// arrived while we were down. Then settle into the poll cadence.
	if err := w.drain(ctx); err != nil {
		log.Warn().Err(err).Msg("nickclaim: initial drain failed")
	}

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			if err := w.drain(ctx); err != nil {
				log.Warn().Err(err).Msg("nickclaim: POP3 drain failed (will retry next tick)")
			}
		}
	}
}

func (w *Worker) sweepLoop(ctx context.Context) {
	log := logger.FromCtx(ctx)
	t := time.NewTicker(w.cfg.SweepInterval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			n, err := w.repo.ExpireBefore(ctx, time.Now().UTC())
			if err != nil {
				log.Warn().Err(err).Msg("nickclaim: sweeper error")
				continue
			}
			if n > 0 {
				log.Info().Int64("expired", n).Msg("nickclaim: expired stale claims")
			}
		}
	}
}

// drain opens a POP3 session, walks every message, processes each,
// and disconnects. DELE happens during the session; Quit() commits
// the deletions atomically (POP3 spec). On any per-message error
// we log + skip; one bad message shouldn't poison the whole batch.
func (w *Worker) drain(ctx context.Context) error {
	log := logger.FromCtx(ctx)

	client := pop3.New(pop3.Opt{
		Host:       w.cfg.Host,
		Port:       w.cfg.Port,
		TLSEnabled: w.cfg.UseTLS,
	})
	conn, err := client.NewConn()
	if err != nil {
		return fmt.Errorf("dial pop3: %w", err)
	}
	// Quit() commits any DELEs from this session. Even if we hit
	// an error mid-batch, we want the deletions for messages we DID
	// process to commit.
	defer func() { _ = conn.Quit() }()

	if err := conn.Auth(w.cfg.User, w.cfg.Password); err != nil {
		return fmt.Errorf("pop3 auth: %w", err)
	}

	count, _, err := conn.Stat()
	if err != nil {
		return fmt.Errorf("pop3 stat: %w", err)
	}
	if count == 0 {
		return nil
	}

	// UIDL gives a stable per-message identifier — useful for the
	// `mail_uid` audit column. Some POP3 servers don't implement
	// it; fall back to the message number on failure (less stable
	// across sessions but fine within one).
	uidls, _ := conn.Uidl(0)
	uidlByID := make(map[int]string, len(uidls))
	for _, u := range uidls {
		uidlByID[u.ID] = u.UID
	}

	for id := 1; id <= count; id++ {
		if err := ctx.Err(); err != nil {
			return err
		}
		uidl := uidlByID[id]
		if uidl == "" {
			uidl = fmt.Sprintf("msgnum-%d", id)
		}
		// Skip messages we already captured on a previous tick. They
		// stay in the inbox by design (audit), and re-parsing them
		// every 5s is wasted work + would race the consumer.
		if seen, err := w.repo.MailUIDCaptured(ctx, uidl); err != nil {
			log.Warn().Err(err).Str("uidl", uidl).
				Msg("nickclaim: uidl dedupe check failed; processing anyway")
		} else if seen {
			continue
		}
		if err := w.handleMessage(ctx, conn, id, uidl); err != nil {
			log.Warn().Err(err).Int("msg_id", id).Str("uidl", uidl).
				Msg("nickclaim: handle message failed (continuing)")
		}
	}
	return nil
}

// handleMessage fetches one message, parses recipient + body,
// captures the code on a matching pending claim, and decides
// disposition:
//
//   - matched (captured a code): LEAVE the message on the server.
//     The next tick's MailUIDCaptured pre-flight will skip it. The
//     user can inspect the source email if they want to audit.
//   - unmatched (no recoverable route to a claim): DELE — these
//     are random catch-all noise, or stale tokens whose claims
//     have expired. Letting them pile up gives an attacker an easy
//     way to fill the mailbox.
//
// Recipient matching tries two routes:
//  1. STRICT — `reg-<userid>-<short>@<domain>` carries the
//     short_token in the local part. Fast O(1) lookup.
//  2. FUZZY — when a catch-all has rewritten the recipient to
//     something like `reg@<domain>` (PurelyMail does this), we
//     extract the account name from the email body and find the
//     newest pending claim for that nick. Atheme + Ergo embed the
//     nick in their templates; Anope doesn't, so an Anope email
//     with a collapsed recipient is unroutable and gets DELE'd.
func (w *Worker) handleMessage(ctx context.Context, conn *pop3.Conn, id int, uidl string) error {
	log := logger.FromCtx(ctx)

	msg, err := conn.Retr(id)
	if err != nil {
		return fmt.Errorf("pop3 retr: %w", err)
	}

	// Recipient: prefer Delivered-To (PurelyMail sets this on
	// catch-all delivery), fall back to the To header.
	recipient := strings.TrimSpace(msg.Header.Get("Delivered-To"))
	if recipient == "" {
		recipient = strings.TrimSpace(msg.Header.Get("To"))
	}
	// Subject is part of the fuzzy-routing signal — Anope embeds
	// the nick in its registration subject template ("Nickname
	// registration for %n"), which is the only path back to the
	// claim when the recipient address has been collapsed.
	subject := strings.TrimSpace(msg.Header.Get("Subject"))

	// Body needed for BOTH the code (always) and the fallback
	// account-name extraction (when fuzzy-routing).
	body, err := readBody(msg)
	if err != nil {
		return fmt.Errorf("read body: %w", err)
	}

	claim, route, err := w.locateClaim(ctx, recipient, subject, body)
	if errors.Is(err, ErrNotFound) {
		log.Debug().Str("recipient", recipient).Str("uidl", uidl).
			Msg("nickclaim: couldn't route email to a pending claim; DELE'ing")
		_ = conn.Dele(id)
		return nil
	}
	if err != nil {
		return fmt.Errorf("locate claim: %w", err)
	}

	code, ok := ExtractCode(body)
	if !ok {
		log.Warn().Str("claim_id", claim.ID.String()).Str("uidl", uidl).
			Msg("nickclaim: could not extract code from body; DELE'ing")
		_ = conn.Dele(id)
		return nil
	}

	if err := w.repo.MarkCaptured(ctx, claim.ID, code, uidl); err != nil {
		if errors.Is(err, ErrStaleStatus) {
			// The claim got captured by a previous tick before our
			// dedupe could see it (race window). Treat as a duplicate
			// and DELE; the user already has the code.
			log.Debug().Str("claim_id", claim.ID.String()).Str("uidl", uidl).
				Msg("nickclaim: claim already captured/consumed; DELE'ing duplicate")
			_ = conn.Dele(id)
			return nil
		}
		// Real DB error — leave the message so the next tick retries.
		return fmt.Errorf("mark captured: %w", err)
	}

	log.Info().Str("route", route).Str("claim_id", claim.ID.String()).
		Str("uidl", uidl).Msg("nickclaim: captured code (email retained for audit)")
	// Intentionally NOT calling conn.Dele(id) — see the disposition
	// policy comment on the Worker type. MailUIDCaptured pre-flight
	// will skip this message on subsequent ticks.
	return nil
}

// locateClaim picks the pending claim this email belongs to. Returns
// the claim, the route name (for logging), or ErrNotFound when neither
// strict nor fuzzy routing yields a match.
func (w *Worker) locateClaim(ctx context.Context, recipient, subject, body string) (*NickClaim, string, error) {
	if token, ok := ParseRecipient(recipient); ok {
		claim, err := w.repo.FindByShortToken(ctx, token)
		if err == nil {
			return claim, "short_token", nil
		}
		if !errors.Is(err, ErrNotFound) {
			return nil, "", err
		}
		// Fall through to fuzzy in case the token-bearing recipient
		// belonged to a claim we no longer have (expired/foreign) but
		// the body's account name maps to a fresh one we do.
	}
	// Fuzzy fallback: catch-all collapse → extract nick from body
	// or subject. Anope's body+subject both carry the nick;
	// Atheme/Ergo carry it in the body's IRC command line.
	if nick, ok := ExtractAccountName(subject, body); ok {
		claim, err := w.repo.FindNewestPendingByNick(ctx, nick)
		if err == nil {
			return claim, "fuzzy_nick", nil
		}
		if !errors.Is(err, ErrNotFound) {
			return nil, "", err
		}
	}
	return nil, "", ErrNotFound
}

// readBody flattens a message.Entity to its plaintext body. For
// simple single-part text/plain messages (what NickServ emits via
// Anope/Atheme/Ergo templates) it's just the body Reader. For
// multipart messages we walk the parts and concatenate every inline
// text body — the extractor scans the result for `/msg NickServ`
// patterns either way.
func readBody(entity *message.Entity) (string, error) {
	mr := entity.MultipartReader()
	if mr == nil {
		b, err := io.ReadAll(entity.Body)
		if err != nil {
			return "", err
		}
		return string(b), nil
	}
	var b strings.Builder
	for {
		part, err := mr.NextPart()
		if err == io.EOF {
			break
		}
		if err != nil {
			return b.String(), err
		}
		// Only consider text/* parts. NickServ never sends
		// attachments, and binary parts would just confuse the
		// regex extractor.
		ct, _, _ := part.Header.ContentType()
		if !strings.HasPrefix(ct, "text/") {
			_, _ = io.Copy(io.Discard, part.Body)
			continue
		}
		data, _ := io.ReadAll(part.Body)
		b.Write(data)
		b.WriteString("\n")
	}
	return b.String(), nil
}
