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
    // Most modern browsers — Chrome explicitly, Firefox sometimes,
    // Safari often — drop the URL fragment when navigating to a
    // custom-scheme URL. That made the first cut of this page fail
    // silently: the boson:// handler in Electron received the URL
    // *without* #access_token=... and had no tokens to hydrate the
    // session with.
    //
    // To sidestep the fragment-stripping question entirely, we move
    // every Supabase-emitted key into the query string before handing
    // off. The Electron-side parser already accepts both forms
    // (parseAuthConfirmedUrl reads from search OR hash) so the rest of
    // the flow doesn't need to change.
    const hashParams = new URLSearchParams((window.location.hash || '').replace(/^#/, ''));
    const queryParams = new URLSearchParams(window.location.search || '');
    if (hashParams.size === 0 && queryParams.size === 0) return;

    // Merge — query wins on conflict (it carries the PKCE code, which
    // is the authoritative form when present).
    const merged = new URLSearchParams();
    hashParams.forEach((v, k) => merged.set(k, v));
    queryParams.forEach((v, k) => merged.set(k, v));

    const target = `boson://auth/confirmed?${merged.toString()}`;
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
                href={(() => {
                  // Same hash→query conversion as the auto-open path so
                  // the click-to-launch fallback survives browsers that
                  // strip fragments on custom-scheme navigation.
                  const h = new URLSearchParams((window.location.hash || '').replace(/^#/, ''));
                  const q = new URLSearchParams(window.location.search || '');
                  const m = new URLSearchParams();
                  h.forEach((v, k) => m.set(k, v));
                  q.forEach((v, k) => m.set(k, v));
                  return `boson://auth/confirmed?${m.toString()}`;
                })()}
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
