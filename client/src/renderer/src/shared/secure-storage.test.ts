import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { InMemorySecureStorage, windowSecureStorage } from './secure-storage';

// happy-dom provides `window` but no `window.bosonSecure` — that's the
// "fallback" path we exercise here. Production builds inject `bosonSecure`
// via the Electron preload script.

describe('windowSecureStorage', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // Defensive: anything from a previous test that polluted globalThis.
    delete (window as { bosonSecure?: unknown }).bosonSecure;
  });

  afterEach(() => {
    warnSpy.mockRestore();
    delete (window as { bosonSecure?: unknown }).bosonSecure;
  });

  it('isAvailable() returns false when window.bosonSecure is undefined', async () => {
    expect(await windowSecureStorage.isAvailable()).toBe(false);
    // Should warn loudly so a misconfigured production build is noticed.
    expect(warnSpy).toHaveBeenCalled();
  });

  it('falls back to an in-memory Map when window.bosonSecure is undefined', async () => {
    await windowSecureStorage.set('k', 'v');
    expect(await windowSecureStorage.get('k')).toBe('v');
    await windowSecureStorage.remove('k');
    expect(await windowSecureStorage.get('k')).toBeNull();
  });

  it('delegates to window.bosonSecure when present', async () => {
    const isAvailable = vi.fn(async () => true);
    const get = vi.fn(async (_k: string) => 'from-bridge');
    const set = vi.fn(async (_k: string, _v: string) => {});
    const remove = vi.fn(async (_k: string) => {});
    (window as { bosonSecure?: unknown }).bosonSecure = { isAvailable, get, set, remove };

    expect(await windowSecureStorage.isAvailable()).toBe(true);
    expect(await windowSecureStorage.get('k1')).toBe('from-bridge');
    await windowSecureStorage.set('k2', 'v2');
    await windowSecureStorage.remove('k3');

    expect(isAvailable).toHaveBeenCalledOnce();
    expect(get).toHaveBeenCalledWith('k1');
    expect(set).toHaveBeenCalledWith('k2', 'v2');
    expect(remove).toHaveBeenCalledWith('k3');
  });

  it('isAvailable() returns false when the bridge throws', async () => {
    (window as { bosonSecure?: unknown }).bosonSecure = {
      isAvailable: vi.fn(async () => { throw new Error('IPC broken'); }),
      get: vi.fn(),
      set: vi.fn(),
      remove: vi.fn(),
    };
    expect(await windowSecureStorage.isAvailable()).toBe(false);
  });
});

describe('InMemorySecureStorage', () => {
  it('reports available', async () => {
    expect(await new InMemorySecureStorage().isAvailable()).toBe(true);
  });

  it('round-trips set/get/remove', async () => {
    const s = new InMemorySecureStorage();
    expect(await s.get('k')).toBeNull();
    await s.set('k', 'v');
    expect(await s.get('k')).toBe('v');
    await s.remove('k');
    expect(await s.get('k')).toBeNull();
  });
});
