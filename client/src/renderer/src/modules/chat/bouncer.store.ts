import { windowSecureStorage, type SecureStorage } from '../../shared/secure-storage';
import type { BouncerProfileSecret } from '../identity/crypto';

// The user's GLOBAL bouncer (ZNC/BNC) profile. There's exactly one per device
// install. Stored as plaintext JSON in the OS keychain (SecureStorage) — i.e.
// encrypted at rest, same as the per-server NickServ creds. The E2E ciphertext
// form (encryptBouncer) is only the on-the-wire shape for backend sync; this
// store holds the usable plaintext so the connect path can read it
// synchronously after hydration.
export type BouncerProfile = BouncerProfileSecret;

export type BouncerListener = (profile: BouncerProfile | null) => void;

export interface BouncerStore {
  // Synchronous snapshot. Returns null until hydrated or when unset. Connect
  // should `await whenHydrated()` once before relying on this.
  get(): BouncerProfile | null;
  set(profile: BouncerProfile): void;
  clear(): void;
  subscribe(fn: BouncerListener): () => void;
  whenHydrated(): Promise<void>;
}

const SECURE_KEY = 'boson.bouncer.v1';

export class SecureBouncerStore implements BouncerStore {
  private cache: BouncerProfile | null = null;
  private available = false;
  private readonly listeners = new Set<BouncerListener>();
  private readonly hydrating: Promise<void>;
  // Serialize writes after hydration so we never persist over the stored value
  // before it has loaded.
  private writeChain: Promise<void>;
  private readonly probeIntervalMs: number;
  private readonly probeTimeoutMs: number;

  constructor(
    private readonly secure: SecureStorage,
    opts: { probeIntervalMs?: number; probeTimeoutMs?: number } = {},
  ) {
    this.probeIntervalMs = opts.probeIntervalMs ?? 120;
    this.probeTimeoutMs = opts.probeTimeoutMs ?? 3000;
    this.hydrating = this.hydrate();
    this.writeChain = this.hydrating;
  }

  whenHydrated(): Promise<void> {
    return this.hydrating;
  }

  get(): BouncerProfile | null {
    return this.cache;
  }

  set(profile: BouncerProfile): void {
    this.cache = profile;
    this.persist();
    this.emit();
  }

  clear(): void {
    this.cache = null;
    this.persist();
    this.emit();
  }

  subscribe(fn: BouncerListener): () => void {
    this.listeners.add(fn);
    fn(this.cache);
    return () => { this.listeners.delete(fn); };
  }

  private async hydrate(): Promise<void> {
    this.available = await this.waitForBacking();
    if (!this.available) return; // no keychain → in-memory only this session
    try {
      const raw = await this.secure.get(SECURE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as BouncerProfile;
        if (parsed && typeof parsed === 'object') this.cache = parsed;
      }
    } catch {
      // Corrupt/unreadable → start empty.
    }
    this.emit();
  }

  private persist(): void {
    this.writeChain = this.writeChain
      .then(async () => {
        if (!this.available) return;
        if (this.cache) await this.secure.set(SECURE_KEY, JSON.stringify(this.cache));
        else await this.secure.remove(SECURE_KEY);
      })
      .catch(() => { /* best effort */ });
  }

  private async waitForBacking(): Promise<boolean> {
    let elapsed = 0;
    for (;;) {
      let ok = false;
      try { ok = await this.secure.isAvailable(); } catch { ok = false; }
      if (ok) return true;
      if (elapsed >= this.probeTimeoutMs) return false;
      await new Promise((r) => setTimeout(r, this.probeIntervalMs));
      elapsed += this.probeIntervalMs;
    }
  }

  private emit(): void {
    for (const fn of this.listeners) fn(this.cache);
  }
}

// Module singleton, mirroring getServiceCredentialsStore(). Tests inject their
// own backing via setBouncerStore before the first get.
let store: BouncerStore | null = null;

export function getBouncerStore(): BouncerStore {
  if (!store) store = new SecureBouncerStore(windowSecureStorage);
  return store;
}

export function setBouncerStore(next: BouncerStore): void {
  store = next;
}
