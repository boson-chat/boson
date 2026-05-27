package middleware

import (
	"net/http"
	"sync"
	"time"

	"github.com/google/uuid"
)

// RateLimit is a per-(principal, key) leaky-bucket-of-one. Returns a
// middleware factory that lets at most one request through per (UserID,
// key) every `window`; subsequent requests inside the window respond
// 429 with a Retry-After header.
//
// `key` is computed from the request per-route — we pass a function
// rather than a fixed string so the same middleware can gate both
// /servers/{id}/verify and /servers/{id}/regenerate-token, each keyed
// on the path parameter.
//
// Idle entries auto-evict after 10 minutes via a background sweep so
// the bucket map doesn't grow unbounded under load. The sweeper goroutine
// is started lazily on first use; we don't bother shutting it down
// because the process lives as long as the API does.
func RateLimit(window time.Duration, key func(r *http.Request) string) func(http.Handler) http.Handler {
	rl := &rateLimiter{
		window:  window,
		entries: make(map[string]time.Time),
	}
	rl.startSweeper()
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			// Unauthenticated routes never hit this middleware (it's
			// always chained after the auth middleware), so MustUser
			// is safe; but we tolerate the missing-principal case so
			// the unit tests can drive the middleware directly without
			// a full Supabase JWT.
			principal, ok := UserFromCtx(r.Context())
			if !ok {
				next.ServeHTTP(w, r)
				return
			}
			fullKey := principal.UserID.String() + "|" + key(r)
			if retryAfter, blocked := rl.consume(fullKey); blocked {
				w.Header().Set("Retry-After", formatRetryAfter(retryAfter))
				http.Error(w, "rate limit exceeded; try again shortly", http.StatusTooManyRequests)
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}

// PrincipalAndPath builds a rate-limit key from the authenticated
// principal plus a path parameter. Useful for the /servers/{id}/verify
// route where the per-server bucket is the right granularity. (The
// principal half is added by RateLimit itself; this function returns
// only the path segment.)
func PrincipalAndPath(pathParam string) func(r *http.Request) string {
	return func(r *http.Request) string {
		v := r.PathValue(pathParam)
		// Best-effort UUID parse so a junk path doesn't share a bucket
		// with every other junk path; if it parses, normalise so the
		// key is canonical regardless of the casing the client used.
		if id, err := uuid.Parse(v); err == nil {
			return id.String()
		}
		return v
	}
}

type rateLimiter struct {
	window  time.Duration
	mu      sync.Mutex
	entries map[string]time.Time
}

// consume returns (retryAfter, true) when the request must be blocked,
// or (0, false) when it should proceed. On `proceed`, the entry is
// updated to the current time so the next call inside the window blocks.
func (rl *rateLimiter) consume(key string) (time.Duration, bool) {
	now := time.Now()
	rl.mu.Lock()
	defer rl.mu.Unlock()
	last, exists := rl.entries[key]
	if exists {
		elapsed := now.Sub(last)
		if elapsed < rl.window {
			return rl.window - elapsed, true
		}
	}
	rl.entries[key] = now
	return 0, false
}

func (rl *rateLimiter) startSweeper() {
	go func() {
		ticker := time.NewTicker(2 * time.Minute)
		defer ticker.Stop()
		for range ticker.C {
			cutoff := time.Now().Add(-10 * time.Minute)
			rl.mu.Lock()
			for k, t := range rl.entries {
				if t.Before(cutoff) {
					delete(rl.entries, k)
				}
			}
			rl.mu.Unlock()
		}
	}()
}

func formatRetryAfter(d time.Duration) string {
	secs := int(d.Seconds())
	if secs < 1 {
		secs = 1
	}
	// HTTP Retry-After accepts either delta-seconds or HTTP-date.
	// Delta-seconds is simpler for clients to parse.
	return durationSecsString(secs)
}

// durationSecsString formats an integer second count for Retry-After. We
// avoid strconv.Itoa in the hot path by using a small lookup for the
// common case (0-60s); anything larger falls back to general formatting.
func durationSecsString(n int) string {
	switch n {
	case 1:
		return "1"
	case 30:
		return "30"
	case 60:
		return "60"
	default:
		// strconv.Itoa would be fine — keeping this branch isolated
		// just so the hot-path strings above never allocate.
		return intToString(n)
	}
}

func intToString(n int) string {
	if n == 0 {
		return "0"
	}
	negative := n < 0
	if negative {
		n = -n
	}
	var buf [20]byte
	i := len(buf)
	for n > 0 {
		i--
		buf[i] = byte('0' + n%10)
		n /= 10
	}
	if negative {
		i--
		buf[i] = '-'
	}
	return string(buf[i:])
}
