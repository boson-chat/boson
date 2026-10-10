import { describe, it, expect, vi } from 'vitest';
import { signOutAndForget } from './sign-out';

function deps(userId: string | null) {
  const calls: string[] = [];
  return {
    calls,
    auth: {
      getState: () => ({ session: userId ? { user: { id: userId } } : null, loading: false, error: null }) as never,
      signOut: vi.fn(async () => { calls.push('auth.signOut'); }),
    },
    identity: {
      clearStorage: vi.fn(async (id: string) => { calls.push(`identity.clearStorage:${id}`); }),
      lock: vi.fn(() => { calls.push('identity.lock'); }),
    },
    sessionStore: { clear: vi.fn(() => { calls.push('session.clear'); }) },
    history: { wipeAllForUser: vi.fn(async (id: string) => { calls.push(`history.wipe:${id}`); }) },
  };
}

describe('signOutAndForget', () => {
  it('forgets the session, keychain secret and history before ending the auth session', async () => {
    const d = deps('u1');
    await signOutAndForget(d);
    expect(d.calls).toEqual([
      'session.clear', 'identity.clearStorage:u1', 'history.wipe:u1', 'identity.lock', 'auth.signOut',
    ]);
  });

  it('still signs out when the history wipe fails', async () => {
    const d = deps('u1');
    d.history.wipeAllForUser.mockRejectedValueOnce(new Error('idb'));
    await signOutAndForget(d);
    expect(d.calls).toEqual(['session.clear', 'identity.clearStorage:u1', 'identity.lock', 'auth.signOut']);
  });

  it('skips the per-user cleanup without a session', async () => {
    const d = deps(null);
    await signOutAndForget(d);
    expect(d.identity.clearStorage).not.toHaveBeenCalled();
    expect(d.calls).toEqual(['session.clear', 'identity.lock', 'auth.signOut']);
  });
});
