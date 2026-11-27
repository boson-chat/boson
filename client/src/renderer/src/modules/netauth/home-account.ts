// A federated main session (a self-hosted web client signed in with
// "Continue as alice@boson.chat") belongs to the home account: the home
// (boson.chat) is the source of truth for everything that is the user's
// rather than the remote server's.
//
//   home (boson.chat's API, with the home account's own token, the one
//   the "Continue as …" flow already holds in NetworkAccounts):
//     /me (handle, display name, avatar, the identity key's wraps),
//     /me/session (saved networks + synced preferences), /me/nickserv-secrets,
//     /me/bouncer
//   remote (this app's own API and auth, the federated session's token):
//     the IRC account and nick (federated.handle), its channels and roles,
//     presence and nick claims on its networks, hosting, files, voice
//
// The identity key is the home account's (its blob from home /me), never a
// new key per server, and it is unlocked only when something needs it
// (modules/identity/key-request.ts).
//
// The home's API isn't named in boson.json: it's the auth service's
// sibling (auth.boson.chat → api.boson.chat), the layout every Boson stack
// uses.

import type { AuthService, Session } from '../auth/auth.service';
import { DirectoryService } from '../directory/directory.service';
import { HttpClient } from '../../shared/http/http.client';
import type { ApiTransport } from '../../shared/http/transport';
import type { FederatedIdentity } from './federation';

// Where the home account's session lives (NetworkAccounts.homeAuthFor).
export interface HomeAuthSource {
  homeAuthFor(f: FederatedIdentity): Promise<AuthService | null>;
}

let source: HomeAuthSource | null = null;
const listeners = new Set<() => void>();

export function setHomeAuthSource(s: HomeAuthSource | null): void {
  source = s;
  listeners.forEach((fn) => fn());
}

export function onHomeAuthSourceChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

/** The federated identity of a main session, or null for a local / SSO account. */
export function federatedOf(session: Session | null | undefined): FederatedIdentity | null {
  return session?.federated ?? null;
}

/** https://auth.boson.chat → https://api.boson.chat (null when the auth host isn't auth.*). */
export function homeApiUrlFor(authUrl: string): string | null {
  let u: URL;
  try { u = new URL(authUrl); } catch { return null; }
  const host = u.hostname.toLowerCase();
  // auth.<domain>, the domain at least two labels (a local stack's
  // auth.localhost too).
  if (!host.startsWith('auth.') || (host.split('.').length < 3 && host !== 'auth.localhost')) return null;
  return `${u.protocol}//api.${host.slice('auth.'.length)}${u.port ? `:${u.port}` : ''}`;
}

// The home account, signed in here: its auth service (the token), its API
// and its user id (the identity key is kept on this device under it).
export interface HomeAccountHandle {
  auth: AuthService;
  directory: DirectoryService;
  userId: string;
  identity: string;
  homeDomain: string;
}

export class HomeUnavailableError extends Error {
  constructor(public readonly homeDomain: string) {
    super(`Sign in to ${homeDomain || 'your home server'} in this browser to use your account's data here.`);
    this.name = 'HomeUnavailableError';
  }
}

/**
 * The home account behind the main session, when that session is federated
 * and the home account is signed in on this device. null otherwise (a local
 * account, or the home signed out).
 */
export class HomeAccountData {
  private readonly dirs = new Map<string, { auth: AuthService; dir: DirectoryService }>();

  constructor(
    private readonly mainAuth: Pick<AuthService, 'getState'>,
    private readonly opts: { transport?: ApiTransport; apiUrlFor?: (authUrl: string) => string | null } = {},
  ) {}

  federated(): FederatedIdentity | null {
    return federatedOf(this.mainAuth.getState().session);
  }

  async home(): Promise<HomeAccountHandle | null> {
    const f = this.federated();
    if (!f || !source) return null;
    let auth: AuthService | null;
    try {
      auth = await source.homeAuthFor(f);
    } catch {
      return null;
    }
    const s = auth?.getState().session;
    if (!auth || !s) return null;
    const api = (this.opts.apiUrlFor ?? homeApiUrlFor)(f.homeAuthUrl);
    if (!api) return null;
    let hit = this.dirs.get(api);
    if (!hit || hit.auth !== auth) {
      const svc = auth;
      hit = {
        auth,
        dir: new DirectoryService(new HttpClient(api, {
          getToken: () => svc.getToken(),
          tokenRejected: (t) => svc.tokenRejected(t),
        }, this.opts.transport)),
      };
      this.dirs.set(api, hit);
    }
    return { auth, directory: hit.dir, userId: s.user.id, identity: f.identity, homeDomain: f.homeDomain };
  }
}
