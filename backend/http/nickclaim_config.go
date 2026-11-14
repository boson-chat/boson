package http

import (
	"context"
	stdhttp "net/http"
	"time"

	"github.com/boson-chat/boson/backend/config"
	"github.com/boson-chat/boson/backend/internal/configfile"
	"github.com/boson-chat/boson/backend/internal/logger"
	"github.com/boson-chat/boson/backend/internal/services/nickclaim"
)

// configPoll is the config file's mtime poll (fallback for file systems
// without change events); tests shorten it.
var configPoll = configfile.DefaultPoll

// startNickClaimConfig applies the nick_claim settings and, with
// BOSON_CONFIG set, watches the stack config file so changes apply live.
// It returns the watcher's status func for GET /internal/config/status
// (nil without BOSON_CONFIG).
func startNickClaimConfig(ctx context.Context, cfg config.Config, rt nickclaim.RuntimeImpl) (func() configfile.Status, error) {
	log := logger.FromCtx(ctx)
	env := config.NickClaimFromEnv(cfg.AppConfig)
	if cfg.StackConfig.Path == "" {
		rt.Apply(ctx, envSettings(ctx, env))
		return nil, nil
	}
	w := configfile.New(configfile.Options[config.NickClaimSettings]{
		Path: cfg.StackConfig.Path,
		Load: func(doc *configfile.Document) (config.NickClaimSettings, error) {
			return config.LoadNickClaimFile(doc, env)
		},
		Apply: func(ctx context.Context, c configfile.Change[config.NickClaimSettings]) {
			if !c.Next.Present {
				rt.Apply(ctx, envSettings(ctx, env))
				return
			}
			if len(c.Next.Value.Unknown) > 0 {
				log.Warn().Strs("keys", c.Next.Value.Unknown).Msg("config: unknown nick_claim keys ignored")
			}
			rt.Apply(ctx, ToRuntimeSettings(c.Next.Value, ""))
		},
		Poll: configPoll,
		Log:  log,
	})
	if err := w.Load(ctx); err != nil {
		return nil, err
	}
	go w.Run(ctx)
	return w.Status, nil
}

// envSettings validates env-only settings: enabled without a domain or
// host runs disabled and reports why.
func envSettings(ctx context.Context, env config.NickClaimSettings) nickclaim.Settings {
	if err := env.Validate(); err != nil {
		logger.FromCtx(ctx).Error().Err(err).Msg("nickclaim: settings invalid; nick claims stay off")
		s := ToRuntimeSettings(env, err.Error())
		s.Enabled = false
		return s
	}
	return ToRuntimeSettings(env, "")
}

// ToRuntimeSettings maps config settings onto the service's.
func ToRuntimeSettings(s config.NickClaimSettings, configErr string) nickclaim.Settings {
	return nickclaim.Settings{
		Enabled:          s.Enabled,
		EmailDomain:      s.EmailDomain,
		RateLimitPerHour: s.RateLimitPerHour,
		Inbound: nickclaim.WorkerConfig{
			Host:     s.Inbound.Host,
			Port:     s.Inbound.Port,
			User:     s.Inbound.User,
			Password: s.Inbound.Password,
			UseTLS:   s.Inbound.TLS,
		},
		ConfigError: configErr,
	}
}

// serveInternal runs the internal listener until ctx ends.
func serveInternal(ctx context.Context, addr string, h stdhttp.Handler) {
	log := logger.FromCtx(ctx)
	srv := &stdhttp.Server{Addr: addr, Handler: h, ReadHeaderTimeout: 5 * time.Second}
	go func() {
		<-ctx.Done()
		_ = srv.Close()
	}()
	log.Info().Str("addr", addr).Msg("internal HTTP listener (compose network only)")
	if err := srv.ListenAndServe(); err != nil && err != stdhttp.ErrServerClosed {
		log.Error().Err(err).Str("addr", addr).Msg("internal listener failed")
	}
}
