import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  __resetSignOut, configureSignOut, isSigningOut, onSignOutChange, registerForSignOut, signOut,
  type SignOutContext, type SignOutPhase,
} from './sign-out';
import { loadGuestSession, saveGuestSession } from '../guest/guest';

function deps(userId: string | null, calls: string[]) {
  return {
    auth: {
      getState: () => ({ session: userId ? { user: { id: userId } } : null, loading: false, error: null }) as never,
      signOut: vi.fn(async () => { calls.push('auth.signOut'); }),
    },
    identity: { lock: vi.fn(() => { calls.push('identity.lock'); }) },
  };
}

function step(name: string, phase: SignOutPhase, calls: string[], fn?: (ctx: SignOutContext) => unknown) {
  return registerForSignOut({
    name, phase,
    clearForSignOut: async (ctx) => { await fn?.(ctx); calls.push(name); },
  });
}

afterEach(() => {
  __resetSignOut();
  localStorage.clear();
  vi.useRealTimers();
});

describe('signOut', () => {
  it('runs stop → disconnect → lock + end the session → wipe → storage, with the account', async () => {
    const calls: string[] = [];
    const seen: SignOutContext[] = [];
    step('storage', 'storage', calls, (c) => seen.push(c));
    step('wipe', 'wipe', calls);
    step('disconnect', 'disconnect', calls);
    step('stop', 'stop', calls);
    await signOut(deps('usr_a', calls));
    expect(calls).toEqual(['stop', 'disconnect', 'identity.lock', 'auth.signOut', 'wipe', 'storage']);
    expect(seen).toEqual([{ userId: 'usr_a', guest: false }]);
  });

  it('isolates a failing or hanging participant', async () => {
    vi.useFakeTimers();
    const calls: string[] = [];
    registerForSignOut({ name: 'boom', phase: 'wipe', clearForSignOut: () => { throw new Error('x'); } });
    registerForSignOut({ name: 'hang', phase: 'disconnect', clearForSignOut: () => new Promise(() => {}) });
    step('after', 'storage', calls);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const p = signOut(deps('u', calls));
    await vi.advanceTimersByTimeAsync(10_000);
    const r = await p;
    expect(r.failed.sort()).toEqual(['boom', 'hang']);
    expect(calls).toEqual(['identity.lock', 'auth.signOut', 'after']);
    warn.mockRestore();
  });

  it('still wipes when the logout request fails', async () => {
    const calls: string[] = [];
    step('storage', 'storage', calls);
    const d = deps('u', calls);
    d.auth.signOut.mockRejectedValueOnce(new Error('offline'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect((await signOut(d)).failed).toEqual(['auth']);
    expect(calls).toContain('storage');
    warn.mockRestore();
  });

  it('leaving guest mode is a sign-out with guest: true, and ends guest mode', async () => {
    saveGuestSession({ nick: 'visitor' });
    const calls: string[] = [];
    const seen: SignOutContext[] = [];
    step('wipe', 'wipe', calls, (c) => seen.push(c));
    const changed = vi.fn();
    window.addEventListener('boson:guest:change', changed);
    await signOut(deps(null, calls));
    window.removeEventListener('boson:guest:change', changed);
    expect(seen).toEqual([{ userId: null, guest: true }]);
    expect(loadGuestSession()).toBeNull();
    expect(changed).toHaveBeenCalled();
  });

  it('shares one run between concurrent calls and reports progress', async () => {
    const calls: string[] = [];
    let release!: () => void;
    registerForSignOut({ name: 'slow', phase: 'wipe', clearForSignOut: () => new Promise<void>((r) => { release = r; }) });
    configureSignOut(deps('u', calls));
    const changes = vi.fn();
    const off = onSignOutChange(changes);
    const a = signOut();
    const b = signOut();
    expect(a).toBe(b);
    expect(isSigningOut()).toBe(true);
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    release();
    await a;
    expect(isSigningOut()).toBe(false);
    expect(calls.filter((c) => c === 'auth.signOut')).toHaveLength(1);
    expect(changes).toHaveBeenCalledTimes(2);
    off();
  });

  it('runs a participant that unregisters mid sign-out (a screen unmounting)', async () => {
    const calls: string[] = [];
    let off: () => void = () => {};
    registerForSignOut({ name: 'first', phase: 'stop', clearForSignOut: () => { off(); } });
    off = step('screen', 'disconnect', calls);
    await signOut(deps('u', calls));
    expect(calls).toContain('screen');
  });

  it('refuses without being configured', async () => {
    await expect(signOut()).rejects.toThrow(/not configured/);
  });
});
