// Federated sign-in (federation spec v1 §5): use a Boson account you
// already have (your "home" server, e.g. alice@boson.chat) on another Boson
// server (the "remote") without signing up there.
//
// Both servers say how in their /.well-known/boson.json `federation` block
// (discovery: desktop/federation.go, platform/web/discovery.ts). The flow:
//
//   1. home  POST assertion_endpoint  (home access token, {audience: remote issuer})
//            → {assertion, expires_in}  — a short-lived signed identity JWT
//   2. remote POST login_endpoint     ({assertion})
//            → the remote's usual token response + {federated, identity, handle}
//
// The remote's session is then stored like any account of that server (its
// own AuthService, keychain key and refresh), marked federated with the
// identity it was made from. No password and no chat data cross servers.
// Signing out of the home account leaves it alone: it lasts until its own
// session ends.

import { AuthError } from '../auth/auth.service';

export type FederationAccepts = 'directory' | 'open' | 'allowlist' | 'off';

// A boson.json federation block, validated.
export interface FederationInfo {
  version: 1;
  // The auth service's token `iss` (the remote's is the assertion audience).
  issuer: string;
  jwks_uri?: string;
  // Where a home server hands out assertions (absent: it doesn't).
  assertion_endpoint?: string;
  // Where a remote server signs an assertion in (absent: it doesn't).
  login_endpoint?: string;
  // This server's trust mode as a remote.
  accepts: FederationAccepts;
  // The domain whose boson.json this is (the identity's home domain).
  domain?: string;
}

// What a federated session remembers about where it came from.
export interface FederatedIdentity {
  // alice@boson.chat
  identity: string;
  // The local handle the remote gave it (its IRC account name and nick).
  handle: string;
  // The home account's auth service, and its domain.
  homeAuthUrl: string;
  homeDomain: string;
}

// An account the user is signed in to that can vouch for them elsewhere.
export interface HomeAccount {
  authUrl: string;
  // The app's own (boson.chat) account.
  main: boolean;
  domain: string;
  username: string;
  // username@domain
  identity: string;
  // The server's display name.
  name: string;
  federation: FederationInfo;
}

const MODES: ReadonlySet<string> = new Set(['directory', 'open', 'allowlist', 'off']);

function isLoopback(hostname: string): boolean {
  return hostname === 'localhost' || hostname.endsWith('.localhost') || hostname === '127.0.0.1' || hostname === '[::1]';
}

function cleanUrl(raw: unknown, allowLoopbackHttp: boolean): URL | null {
  if (typeof raw !== 'string' || raw.length > 2048) return null;
  let u: URL;
  try { u = new URL(raw.trim()); } catch { return null; }
  if (u.protocol !== 'https:' && !(allowLoopbackHttp && u.protocol === 'http:' && isLoopback(u.hostname))) return null;
  if (!u.host || u.username || u.password || u.search || u.hash) return null;
  return u;
}

function strip(u: URL): string {
  return u.toString().replace(/\/+$/, '');
}

/**
 * A boson.json `federation` block, or null when absent or invalid: version
 * 1, a known mode (missing reads as off), an https issuer, and every
 * endpoint on the issuer's origin (the home token goes to the assertion
 * endpoint; the desktop proxy only reaches the network's own auth origin).
 */
export function cleanFederation(raw: unknown, allowLoopbackHttp = false): FederationInfo | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const f = raw as Record<string, unknown>;
  if (f['version'] !== 1) return null;
  const accepts = typeof f['accepts'] === 'string' && f['accepts'] ? f['accepts'].trim().toLowerCase() : 'off';
  if (!MODES.has(accepts)) return null;
  const issuer = cleanUrl(f['issuer'], allowLoopbackHttp);
  if (!issuer) return null;
  const out: FederationInfo = { version: 1, issuer: strip(issuer), accepts: accepts as FederationAccepts };
  for (const k of ['jwks_uri', 'assertion_endpoint', 'login_endpoint'] as const) {
    if (f[k] === undefined || f[k] === '') continue;
    const u = cleanUrl(f[k], allowLoopbackHttp);
    if (!u || u.origin !== issuer.origin) return null;
    out[k] = strip(u);
  }
  if (typeof f['domain'] === 'string' && f['domain']) out.domain = f['domain'].toLowerCase();
  return out;
}

function originOf(u: string): string {
  try { return new URL(u).origin; } catch { return ''; }
}

/** Whether a server signs in accounts from elsewhere. */
export function acceptsFederation(f: FederationInfo | null | undefined, authUrl?: string): f is FederationInfo & { login_endpoint: string } {
  if (!f || f.accepts === 'off' || !f.login_endpoint) return false;
  return !authUrl || originOf(f.login_endpoint) === originOf(authUrl);
}

/** Whether a server vouches for its accounts elsewhere. */
export function issuesAssertions(f: FederationInfo | null | undefined, authUrl?: string): f is FederationInfo & { assertion_endpoint: string } {
  if (!f || f.accepts === 'off' || !f.assertion_endpoint) return false;
  return !authUrl || originOf(f.assertion_endpoint) === originOf(authUrl);
}

/** alice + boson.chat → alice@boson.chat */
export function identityOf(username: string, domain: string): string {
  return `${username}@${domain}`;
}

/** The domain part of alice@boson.chat ('' when there's none). */
export function homeDomainOf(identity: string | null | undefined): string {
  if (!identity) return '';
  const at = identity.lastIndexOf('@');
  return at > 0 ? identity.slice(at + 1) : '';
}

// ---- errors ----

// Spec §3's codes, plus the home side's and the app's own.
export type FederationErrorCode =
  | 'federation_off' | 'domain_not_trusted' | 'domain_blocked' | 'identity_banned'
  | 'discovery_failed' | 'bad_assertion' | 'replayed'
  // The home server wouldn't vouch (guest, disabled, banned there).
  | 'home_refused'
  // The home session is over: sign in there again.
  | 'home_signed_out'
  // The home server has no (working) assertion endpoint.
  | 'home_unsupported'
  | 'rate_limited'
  | 'network'
  | 'invalid_response'
  | 'unknown';

export class FederationError extends Error {
  constructor(
    public readonly code: FederationErrorCode,
    public readonly side: 'home' | 'remote',
    message: string,
    public readonly status = 0,
  ) {
    super(message);
    this.name = 'FederationError';
  }
}

const REMOTE_CODES: ReadonlySet<string> = new Set([
  'federation_off', 'domain_not_trusted', 'domain_blocked', 'identity_banned', 'discovery_failed', 'bad_assertion', 'replayed',
]);

function fromHome(err: unknown): FederationError {
  if (err instanceof FederationError) return err;
  if (!(err instanceof AuthError)) return new FederationError('unknown', 'home', err instanceof Error ? err.message : String(err));
  if (err.code === 'network') return new FederationError('network', 'home', err.message, 0);
  if (err.code === 'rate_limited' || err.status === 429) return new FederationError('rate_limited', 'home', err.message, err.status);
  if (err.code === 'signed_out' || err.status === 401) return new FederationError('home_signed_out', 'home', err.message, err.status);
  if (err.status === 404 || err.status === 405 || err.status === 501 || err.code === 'federation_off') {
    return new FederationError('home_unsupported', 'home', err.message, err.status);
  }
  if (err.status === 403) return new FederationError('home_refused', 'home', err.message, err.status);
  return new FederationError('unknown', 'home', err.message, err.status);
}

function fromRemote(err: unknown): FederationError {
  if (err instanceof FederationError) return err;
  if (!(err instanceof AuthError)) return new FederationError('unknown', 'remote', err instanceof Error ? err.message : String(err));
  if (REMOTE_CODES.has(err.code)) return new FederationError(err.code as FederationErrorCode, 'remote', err.message, err.status);
  if (err.code === 'network') return new FederationError('network', 'remote', err.message, 0);
  if (err.code === 'rate_limited' || err.status === 429) return new FederationError('rate_limited', 'remote', err.message, err.status);
  // No such endpoint: as good as off.
  if (err.status === 404 || err.status === 405 || err.status === 501) return new FederationError('federation_off', 'remote', err.message, err.status);
  return new FederationError('unknown', 'remote', err.message, err.status);
}

export interface DescribeContext {
  // The remote server's display name.
  remote: string;
  // The home account (alice@boson.chat) and its domain.
  identity: string;
  homeDomain: string;
  // The remote's mode (wording for domain_not_trusted).
  accepts?: FederationAccepts;
}

/** A sentence for the sign-in dialog. */
export function describeFederationError(err: unknown, c: DescribeContext): string {
  const e = err instanceof FederationError ? err : fromRemote(err);
  switch (e.code) {
    case 'federation_off':
      return `${c.remote} doesn't accept accounts from other servers.`;
    case 'domain_not_trusted':
      return c.accepts === 'allowlist'
        ? `${c.remote} only accepts accounts from servers its admins have approved, and ${c.homeDomain} isn't one of them.`
        : `This server only accepts accounts from verified Boson servers, and ${c.homeDomain} isn't verified in the directory.`;
    case 'domain_blocked':
      return `${c.remote} doesn't accept accounts from ${c.homeDomain}.`;
    case 'identity_banned':
      return `${c.identity} is banned on ${c.remote}.`;
    case 'discovery_failed':
      return `${c.remote} couldn't check ${c.homeDomain}'s server. Try again in a minute.`;
    case 'bad_assertion':
      return `${c.remote} couldn't verify your ${c.homeDomain} sign-in. Try again.`;
    case 'replayed':
      return 'That sign-in was already used. Try again.';
    case 'home_refused':
      return `${c.homeDomain} won't vouch for ${c.identity} on other servers.`;
    case 'home_signed_out':
      return `Your ${c.homeDomain} sign-in has ended. Sign in to ${c.homeDomain} again, then try this.`;
    case 'home_unsupported':
      return `${c.homeDomain} can't sign you in to other servers yet.`;
    case 'rate_limited':
      return 'Too many attempts. Wait a minute and try again.';
    case 'network':
      return e.side === 'home' ? `Couldn't reach ${c.homeDomain}. Check your connection and try again.` : `Couldn't reach ${c.remote}. Check your connection and try again.`;
    case 'invalid_response':
      return `${e.side === 'home' ? c.homeDomain : c.remote} sent an answer Boson doesn't understand.`;
    default:
      return `Couldn't sign in to ${c.remote} as ${c.identity}${e.message ? `: ${e.message.replace(/\.$/, '')}` : ''}.`;
  }
}

/** Whether trying again (unchanged) could work. */
export function retryable(err: unknown): boolean {
  const code = err instanceof FederationError ? err.code : 'unknown';
  return ['discovery_failed', 'bad_assertion', 'replayed', 'rate_limited', 'network', 'unknown'].includes(code);
}

// ---- the flow ----

// What the flow needs of the two AuthServices (AuthService has both).
export interface AssertionIssuer {
  federationAssertion(endpoint: string, audience: string): Promise<{ assertion: string; expires_in?: number }>;
}
export interface FederatedLoginTarget<S> {
  federatedLogin(endpoint: string, assertion: string, from: { homeAuthUrl: string; homeDomain: string; identity: string }): Promise<S>;
}

/**
 * Signs in to the remote as the home account. Throws FederationError
 * (side says which server refused).
 */
export async function federatedSignIn<S>(opts: {
  home: HomeAccount;
  homeAuth: AssertionIssuer;
  remote: FederationInfo;
  remoteAuthUrl: string;
  remoteAuth: FederatedLoginTarget<S>;
}): Promise<S> {
  const { home, remote } = opts;
  if (!issuesAssertions(home.federation, home.authUrl)) {
    throw new FederationError('home_unsupported', 'home', `${home.domain} has no assertion endpoint.`);
  }
  if (!acceptsFederation(remote, opts.remoteAuthUrl)) {
    throw new FederationError('federation_off', 'remote', 'The server does not accept federated accounts.');
  }
  let assertion: string;
  try {
    const r = await opts.homeAuth.federationAssertion(home.federation.assertion_endpoint!, remote.issuer);
    assertion = typeof r?.assertion === 'string' ? r.assertion : '';
  } catch (err) {
    throw fromHome(err);
  }
  if (!assertion) throw new FederationError('invalid_response', 'home', 'No assertion in the answer.');
  try {
    return await opts.remoteAuth.federatedLogin(remote.login_endpoint!, assertion, {
      homeAuthUrl: home.authUrl, homeDomain: home.domain, identity: home.identity,
    });
  } catch (err) {
    throw fromRemote(err);
  }
}
