package logger

import (
	"context"
	"os"

	"github.com/rs/zerolog"
)

type ctxKey struct{}

var defaultLogger zerolog.Logger

func init() {
	defaultLogger = zerolog.New(os.Stdout).With().Timestamp().Logger()
}

type Option func(*zerolog.Logger)

func WithServerName(name string) Option {
	return func(l *zerolog.Logger) {
		*l = l.With().Str("server", name).Logger()
	}
}

func WithVersion(v string) Option {
	return func(l *zerolog.Logger) {
		*l = l.With().Str("version", v).Logger()
	}
}

func WithEnvironment(env string) Option {
	return func(l *zerolog.Logger) {
		*l = l.With().Str("env", env).Logger()
	}
}

func Logger(opts ...Option) *zerolog.Logger {
	l := defaultLogger
	for _, opt := range opts {
		opt(&l)
	}
	defaultLogger = l
	return &defaultLogger
}

func FromCtx(ctx context.Context) *zerolog.Logger {
	if l, ok := ctx.Value(ctxKey{}).(*zerolog.Logger); ok {
		return l
	}
	return &defaultLogger
}

func WithCtx(ctx context.Context, l *zerolog.Logger) context.Context {
	return context.WithValue(ctx, ctxKey{}, l)
}
