import { useEffect, useState } from 'preact/hooks';
import { useLatestRelease } from '../hooks/useLatestRelease';
import './AuthConfirmedPage.css';

/**
 * Email-confirmation landing page. Supabase verifies the user
 * server-side and 302s here with the access + refresh tokens in the
 * URL fragment (#access_token=...&refresh_token=...&type=signup).
 *
 * What we do: forward the entire fragment to a `boson://auth/confirmed`
 * deep-link so the desktop app can hydrate the session and continue
 * the user into chat. If the deep-link doesn't fire (because Boson
 * isn't installed, or the OS doesn't have the handler registered, or
 * the browser silently refuses to follow custom-scheme links), the
 * page renders a fallback CTA after ~2 seconds with the download link.
 *
 * The page itself never touches the access token — we just hand the
 * hash on to the app and let the desktop AuthService call
 * supabase.auth.setSession with it. Avoiding a setSession call here
 * means we don't need a Supabase client on the website at all.
 */
export function AuthConfirmedPage() {
  const release = useLatestRelease();
  const [showFallback, setShowFallback] = useState(false);

  useEffect(() => {
    // Grab the entire fragment as-is and hand it to Boson. The hash
    // already begins with '#' from location.hash so we don't double-
    // prefix; URL-encode is unnecessary because the hash format
    // Supabase emits is already URL-safe (&-separated key=value).
    const hash = window.location.hash || '';
    const search = window.location.search || '';
    // Some flows (PKCE) carry the code in the query string instead of
    // the fragment — forward whichever applies. If both are empty we
    // skip the deep-link entirely; the user landed here directly.
    if (!hash && !search) return;

    const target = `boson://auth/confirmed${search}${hash}`;
    // Try the deep-link by setting location. The browser will hand
    // off to the OS handler if registered; otherwise nothing happens
    // and we stay on this page (which is exactly when the fallback
    // banner becomes useful).
    window.location.href = target;

    // Show the fallback CTA after a beat. If the deep-link succeeded
    // the user is already in Boson and isn't looking at this page;
    // if they ARE still on the page after 2 seconds, the handoff
    // failed and they need the download link.
    const t = window.setTimeout(() => setShowFallback(true), 2000);
    return () => window.clearTimeout(t);
  }, []);

  return (
    <section class="section auth-confirmed">
      <div class="container" style="max-width: 560px; text-align: center;">
        <p class="eyebrow">Email confirmed</p>
        <h1 style="max-width: 18ch; margin-inline: auto;">
          You're in. Opening Boson…
        </h1>
        <p class="lead" style="margin: 20px auto 0;">
          Your account is confirmed. Boson should open in a moment — when it
          does, you'll be signed in automatically.
        </p>

        {showFallback ? (
          <div class="auth-fallback">
            <p class="muted" style="margin-bottom: 20px;">
              Nothing happened? Either Boson isn't installed yet, or your
              browser blocked the handoff. Pick one:
            </p>
            <div class="hero-cta" style="justify-content: center;">
              <a
                class="btn btn-primary"
                href={`boson://auth/confirmed${window.location.search}${window.location.hash}`}
              >
                Open Boson manually
              </a>
              <a class="btn btn-secondary" href="/download">
                Download Boson v{release.version}
              </a>
            </div>
            <p class="auth-fallback-tip">
              Already installed? After downloading + opening Boson once, this
              link will work for every future confirmation.
            </p>
          </div>
        ) : (
          <p class="muted" style="margin-top: 16px;">
            Don't have Boson installed?{' '}
            <a href="/download" class="docs-link">Grab the desktop client</a>.
          </p>
        )}
      </div>
    </section>
  );
}
