import { useEffect } from 'preact/hooks';
import { useLatestRelease } from '../hooks/useLatestRelease';
import './AuthConfirmedPage.css';

/**
 * Old email-confirmation landing page. Supabase Auth used to redirect here
 * with session tokens, which this page forwarded to boson://auth/confirmed.
 * Boson now uses its own auth service (auth.boson.chat), whose links open
 * its own pages, and the app ignores boson://auth/confirmed. The route
 * stays so links in old emails land somewhere useful; any tokens in the URL
 * are wiped from the address bar and never used.
 */
export function AuthConfirmedPage() {
  const release = useLatestRelease();

  useEffect(() => {
    if (window.location.hash || window.location.search) {
      window.history.replaceState(null, '', window.location.pathname);
    }
  }, []);

  return (
    <section class="section auth-confirmed">
      <div class="container" style="max-width: 560px; text-align: center;">
        <p class="eyebrow">Sign-in has moved</p>
        <h1 style="max-width: 18ch; margin-inline: auto;">
          This link is from our old sign-in system.
        </h1>
        <p class="lead" style="margin: 20px auto 0;">
          Update Boson to the latest version and sign in with your email (or
          your new username) and password. Got a password-reset email from
          Boson? Use the link in it first.
        </p>
        <div class="hero-cta" style="justify-content: center; margin-top: 24px;">
          <a class="btn btn-primary" href="/download">
            Download Boson v{release.version}
          </a>
        </div>
      </div>
    </section>
  );
}
