// The identity key on demand, for a federated main session (signed in with
// "Continue as alice@boson.chat"): signing in doesn't ask for it, since
// this server's IRC login uses its own token. It's needed only to encrypt
// what syncs through the home account (NickServ passwords, the bouncer
// profile, a recovery code), and then the app asks, saying why
// (components/IdentityKeyPrompt.tsx).
//
// The key is the home account's: its blob comes from the home's /me, it's
// unlocked with the passphrase set there (or set up there, the first
// time), and it's kept on this device under the home account's user id,
// so every server this browser signs in to with that account shares it.
//
// Local and SSO accounts unlock the key at sign-in, as before; for them
// the key is always there by the time anything asks.

import type { IdentityService } from './identity.service';
import type { HomeAccountData } from '../netauth/home-account';

export type KeyReason = 'nickserv' | 'bouncer' | 'recovery';

export const KEY_REASONS: Record<KeyReason, string> = {
  nickserv: 'to sync the NickServ password you saved to your other devices',
  bouncer: 'to sync your bouncer settings to your other devices',
  recovery: 'to set up a recovery code for it',
};

export interface KeyRequest {
  reason: KeyReason;
}

interface Pending extends KeyRequest {
  promise: Promise<boolean>;
  resolve: (ok: boolean) => void;
}

let pending: Pending | null = null;
// Reasons the user said "Not now" to this run: not asked again for those
// until they ask themselves (an explicit request passes force).
const declined = new Set<KeyReason>();
const listeners = new Set<(r: KeyRequest | null) => void>();

function emit(): void {
  const r = pending ? { reason: pending.reason } : null;
  listeners.forEach((fn) => fn(r));
}

export function currentKeyRequest(): KeyRequest | null {
  return pending ? { reason: pending.reason } : null;
}

export function onKeyRequest(fn: (r: KeyRequest | null) => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

/**
 * Asks for the identity key (true once it's unlocked). Unlocked already:
 * true at once. A request already up is shared. A reason declined this run
 * resolves false without asking, unless `force` (the user asked for it).
 */
export function requestIdentityKey(identity: Pick<IdentityService, 'isUnlocked'>, reason: KeyReason, opts: { force?: boolean } = {}): Promise<boolean> {
  if (identity.isUnlocked()) return Promise.resolve(true);
  if (pending) return pending.promise;
  if (declined.has(reason) && !opts.force) return Promise.resolve(false);
  let resolve!: (ok: boolean) => void;
  const promise = new Promise<boolean>((r) => { resolve = r; });
  pending = { reason, promise, resolve };
  emit();
  return promise;
}

/** The prompt's outcome: unlocked, or "Not now". */
export function settleKeyRequest(ok: boolean): void {
  const p = pending;
  if (!p) return;
  pending = null;
  if (!ok) declined.add(p.reason);
  p.resolve(ok);
  emit();
}

// The id the key was last kept under on this device (sign-out removes it).
let keptUnder: string | null = null;

export function homeKeyId(): string | null {
  return keptUnder;
}

export function rememberHomeKeyId(id: string | null): void {
  keptUnder = id;
}

/**
 * A federated session's key without asking: the home account's, when this
 * device keeps it (unlocked here before, on any server). true when
 * unlocked.
 */
export async function restoreHomeKey(identity: Pick<IdentityService, 'isUnlocked' | 'restoreFromStorage'>, home: Pick<HomeAccountData, 'home'>): Promise<boolean> {
  if (identity.isUnlocked()) return true;
  const h = await home.home().catch(() => null);
  if (!h) return false;
  rememberHomeKeyId(h.userId);
  return identity.restoreFromStorage(h.userId);
}

// Sign-out (and tests): nothing pending, nothing declined, no kept id.
export function resetKeyRequests(): void {
  if (pending) pending.resolve(false);
  pending = null;
  declined.clear();
  keptUnder = null;
  emit();
}
