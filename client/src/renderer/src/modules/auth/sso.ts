// "Sign in with …" in the desktop app (RFC 8252): the system browser does
// the identity provider's login and comes back to a loopback listener the
// app runs (desktop/sso.go) with a one-time code, which the app trades —
// with the PKCE verifier only it knows — for a session.
//
//   1. begin(): the app listens on http://127.0.0.1:<random>/callback?s=…
//   2. open start_url?return_to=<that>&code_challenge=…&code_challenge_method=S256
//   3. wait(): …/callback?code=bsc_… (or ?error=…&error_description=…)
//   4. POST /v1/sso/exchange {code, code_verifier} within 60 s

import { AuthError, type AuthService, type Session, type SSOProvider } from './auth.service';

export interface SSOBridge {
  begin(): Promise<{ id: string; redirectUri: string }>;
  wait(id: string): Promise<{ code?: string; error?: string; errorDescription?: string }>;
  cancel(id: string): Promise<void>;
  // Opens a URL in the system browser.
  open(url: string): Promise<void>;
}

// window.bosonSSO (platform/wails.ts); absent in a browser and on phones.
export function ssoBridge(): SSOBridge | null {
  return (globalThis as { bosonSSO?: SSOBridge }).bosonSSO ?? null;
}

// The error code for a sign-in the user cancelled (nothing to show).
export const SSO_CANCELLED = 'cancelled';

function base64url(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// A PKCE pair: a 43-character verifier and its S256 challenge.
export async function pkcePair(): Promise<{ verifier: string; challenge: string }> {
  const raw = new Uint8Array(32);
  crypto.getRandomValues(raw);
  const verifier = base64url(raw);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
  return { verifier, challenge: base64url(digest) };
}

export function ssoStartUrl(startUrl: string, redirectUri: string, challenge: string): string {
  const u = new URL(startUrl);
  u.searchParams.set('return_to', redirectUri);
  u.searchParams.set('code_challenge', challenge);
  u.searchParams.set('code_challenge_method', 'S256');
  return u.toString();
}

// A sentence for an error the auth service (or the flow) ended with.
export function describeSSOError(code: string, provider: string, description?: string): string {
  switch (code) {
    case 'access_denied': return `${provider} didn't sign you in (cancelled or refused).`;
    case 'no_linked_account': return `No Boson account is linked to that ${provider} account, and new accounts can't be made through it.`;
    case 'registration_closed': return 'Sign-ups are closed right now, so a new account can\'t be made.';
    case 'invite_required': return 'Sign-ups need an invite code right now.';
    case 'account_disabled': return 'This account has been disabled.';
    case 'idp_unavailable': return `Couldn't reach ${provider}. Try again in a moment.`;
    case 'sso_failed': return `${provider}'s answer didn't check out. Try again.`;
    case 'unknown_provider': return `${provider} sign-in isn't available any more.`;
    case 'timeout': return 'Sign-in took too long. Try again.';
    default: return description || `Sign-in with ${provider} didn't finish (${code}).`;
  }
}

export interface SSOFlowHandle {
  // Resolves with the new session; rejects with an AuthError (code
  // 'cancelled' when cancel() was called).
  done: Promise<Session>;
  cancel(): void;
}

// Runs the whole flow for one provider.
export function signInWithProvider(auth: AuthService, bridge: SSOBridge, provider: SSOProvider): SSOFlowHandle {
  let flowId: string | null = null;
  let cancelled = false;
  const name = provider.display_name || provider.slug;
  const done = (async () => {
    const { verifier, challenge } = await pkcePair();
    const { id, redirectUri } = await bridge.begin();
    flowId = id;
    if (cancelled) {
      void bridge.cancel(id).catch(() => {});
      throw new AuthError(SSO_CANCELLED, 'Sign-in cancelled.', 0);
    }
    await bridge.open(ssoStartUrl(provider.start_url, redirectUri, challenge));
    const r = await bridge.wait(id);
    if (cancelled || r.error === SSO_CANCELLED) throw new AuthError(SSO_CANCELLED, 'Sign-in cancelled.', 0);
    if (r.error || !r.code) {
      const code = r.error || 'invalid_response';
      throw new AuthError(code, describeSSOError(code, name, r.errorDescription), 0);
    }
    return auth.exchangeSSOCode(r.code, verifier);
  })();
  return {
    done,
    cancel() {
      cancelled = true;
      if (flowId) void bridge.cancel(flowId).catch(() => {});
    },
  };
}
