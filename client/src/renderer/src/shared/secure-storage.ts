// SecureStorage is the renderer-facing abstraction over the main-process
// SecureStore. In production it proxies via `window.bosonSecure` (exposed by
// the preload script). In tests and the renderer-only Vite preview there's
// no preload, so we fall back to a memory-only Map with a console warning.
// Production callers should ALWAYS check `isAvailable()` first — the fallback
// returns `false` so identity persistence is correctly disabled rather than
// silently losing the secret to a tab refresh.

export interface SecureStorage {
  isAvailable(): Promise<boolean>;
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
}

// The shape exposed by `src/preload/index.ts`. Kept structurally compatible
// with `BosonSecure` without importing from preload (which would pull in
// `electron` into the renderer bundle).
interface BosonSecureBridge {
  isAvailable(): Promise<boolean>;
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
}

declare global {
  interface Window {
    bosonSecure?: BosonSecureBridge;
  }
}

/**
 * `windowSecureStorage` reads `window.bosonSecure` at every call (not once at
 * module load) so the bridge is picked up even if preload finishes injecting
 * after our module is imported. Falls back to an in-memory Map when the
 * bridge is missing.
 */
class WindowSecureStorage implements SecureStorage {
  private warned = false;
  private readonly fallback = new Map<string, string>();

  private bridge(): BosonSecureBridge | null {
    if (typeof window === 'undefined') return null;
    return window.bosonSecure ?? null;
  }

  private warnOnce(): void {
    if (this.warned) return;
    this.warned = true;
    // Loud warning so a misconfigured production build doesn't silently lose
    // identity persistence. In tests this is expected and harmless.
    // eslint-disable-next-line no-console
    console.warn(
      '[secure-storage] window.bosonSecure is not defined — falling back to ' +
        'in-memory storage. Identity will NOT persist across reloads.',
    );
  }

  async isAvailable(): Promise<boolean> {
    const b = this.bridge();
    if (!b) {
      this.warnOnce();
      return false;
    }
    try {
      return await b.isAvailable();
    } catch {
      return false;
    }
  }

  async get(key: string): Promise<string | null> {
    const b = this.bridge();
    if (!b) {
      this.warnOnce();
      return this.fallback.get(key) ?? null;
    }
    return b.get(key);
  }

  async set(key: string, value: string): Promise<void> {
    const b = this.bridge();
    if (!b) {
      this.warnOnce();
      this.fallback.set(key, value);
      return;
    }
    await b.set(key, value);
  }

  async remove(key: string): Promise<void> {
    const b = this.bridge();
    if (!b) {
      this.warnOnce();
      this.fallback.delete(key);
      return;
    }
    await b.remove(key);
  }
}

// Singleton so the fallback Map is shared per-tab. Production callers should
// use this directly; tests should pass their own in-memory implementation.
export const windowSecureStorage: SecureStorage = new WindowSecureStorage();

/**
 * In-memory `SecureStorage` for tests. Pure-Map; never reaches preload.
 * Marked `isAvailable() === true` so persist/restore paths run end-to-end.
 */
export class InMemorySecureStorage implements SecureStorage {
  private readonly map = new Map<string, string>();

  async isAvailable(): Promise<boolean> { return true; }
  async get(key: string): Promise<string | null> { return this.map.get(key) ?? null; }
  async set(key: string, value: string): Promise<void> { this.map.set(key, value); }
  async remove(key: string): Promise<void> { this.map.delete(key); }
}
