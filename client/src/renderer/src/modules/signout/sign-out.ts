import type { IdentityService } from '../identity';
import type { AuthService } from '../auth/auth.service';
import { clearGuestSession, emitGuestChange, loadGuestSession } from '../guest/guest';

// Sign-out, in one place.
//
// Every module that keeps something of the signed-in person (connections,
// calls, credentials, history, caches, in-memory state) registers a
// participant here, and signOut() runs every participant's clearForSignOut()
// so the next person to sign in on this device starts clean. Both Sign out
// buttons (the directory's and User settings → Account) and leaving guest
// mode go through signOut(); nothing else should end a session by hand.
//
// What is personal and what is a device preference (kept) is listed in
// modules/signout/storage-keys.ts; a test fails when a storage key is in neither list.
//
// Phases, in order (participants within a phase run concurrently, each
// isolated: one failing or hanging can't stop the rest):
//   stop       — stop writers that would push this device's state to the
//                account (the saved-session sync, credential syncs): the wipe
//                below must not propagate as deletes, nor reach the next one.
//   disconnect — leave calls, disconnect every IRC / bouncer session, cancel
//                uploads.
//   (the identity locks and the auth session ends: the login screen shows;
//    the refresh token is revoked server-side, best-effort)
//   wipe       — forget the account's data on this device: history, DMs,
//                notifications, credentials, caches; reset in-memory stores.
//   storage    — last, once nothing writes any more: every ACCOUNT key left
//                in localStorage and the secure store (tokens, keys,
//                credentials, saved servers; signout/storage-keys.ts).

export interface SignOutContext {
  // The account signing out (auth user id), null for a guest.
  userId: string | null;
  // Leaving guest mode.
  guest: boolean;
}

export type SignOutPhase = 'stop' | 'disconnect' | 'wipe' | 'storage';

export interface SignOutParticipant {
  readonly name: string;
  readonly phase: SignOutPhase;
  clearForSignOut(ctx: SignOutContext): void | Promise<void>;
}

const PHASES: readonly SignOutPhase[] = ['stop', 'disconnect', 'wipe', 'storage'];
// A participant that takes longer than this (a bridge that never answers)
// is left behind rather than holding up the sign-out.
const STEP_TIMEOUT_MS = 8_000;

const participants = new Map<string, SignOutParticipant>();

// Registers p (replacing one of the same name); returns the unregister.
export function registerForSignOut(p: SignOutParticipant): () => void {
  participants.set(p.name, p);
  return () => { if (participants.get(p.name) === p) participants.delete(p.name); };
}

export function signOutParticipants(): string[] {
  return Array.from(participants.keys());
}

// Test seam.
export function __resetSignOut(): void {
  participants.clear();
  configured = null;
  inFlight = null;
  for (const fn of listeners) fn();
}

export interface SignOutDeps {
  auth: Pick<AuthService, 'getState' | 'signOut'>;
  identity: Pick<IdentityService, 'lock'>;
}

let configured: SignOutDeps | null = null;

export function configureSignOut(deps: SignOutDeps): void {
  configured = deps;
}

let inFlight: Promise<SignOutResult> | null = null;
const listeners = new Set<() => void>();

// Whether a sign-out is still wiping (the app shows "Signing out…" rather
// than letting the next sign-in race the wipe).
export function isSigningOut(): boolean { return inFlight !== null; }

export function onSignOutChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

export interface SignOutResult {
  // Participants that threw or timed out (logged; the sign-out still ends).
  failed: string[];
}

// Signs out (or leaves guest mode). Concurrent calls share one run.
export function signOut(deps: SignOutDeps | null = configured): Promise<SignOutResult> {
  if (!deps) return Promise.reject(new Error('signOut: not configured'));
  if (inFlight) return inFlight;
  const run = runSignOut(deps).finally(() => {
    inFlight = null;
    for (const fn of listeners) fn();
  });
  inFlight = run;
  for (const fn of listeners) fn();
  return run;
}

async function runSignOut({ auth, identity }: SignOutDeps): Promise<SignOutResult> {
  const ctx: SignOutContext = {
    userId: auth.getState().session?.user?.id ?? null,
    guest: loadGuestSession() !== null,
  };
  const failed: string[] = [];
  // Everyone registered when sign-out starts (a screen unmounting meanwhile
  // still gets its turn).
  const all = Array.from(participants.values());
  const runPhase = async (phase: SignOutPhase): Promise<void> => {
    const steps = all.filter((p) => p.phase === phase);
    await Promise.all(steps.map(async (p) => {
      try {
        await withTimeout(Promise.resolve().then(() => p.clearForSignOut(ctx)), STEP_TIMEOUT_MS);
      } catch (err) {
        failed.push(p.name);
        console.warn(`[sign-out] ${p.name} failed`, err);
      }
    }));
  };

  await runPhase(PHASES[0]!);
  await runPhase(PHASES[1]!);
  // Nothing may decrypt or push for this account from here on.
  identity.lock();
  // Ends the session now (the login screen shows) and revokes the refresh
  // token server-side; the network part isn't waited on before the wipe.
  const authDone = auth.signOut().catch((err) => {
    failed.push('auth');
    console.warn('[sign-out] auth.signOut failed', err);
  });
  await runPhase(PHASES[2]!);
  await runPhase(PHASES[3]!);
  if (ctx.guest) {
    clearGuestSession();
    emitGuestChange();
  }
  await authDone;
  return { failed };
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}
