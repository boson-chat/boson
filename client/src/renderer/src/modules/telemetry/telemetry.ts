// The app ping: Boson's anonymous usage & health stats from the apps
// (desktop, iOS, Android, web). The contract is boson-chat/stack
// docs/telemetry.md ("App ping", schema 1); the receiver rejects unknown
// fields, so the body holds exactly the schema's seven fields.
//
// Once a day per device: when the app starts and whenever it comes back to
// the foreground, if 24 h have passed since the last attempt (sent or not),
// POST https://telemetry.boson.chat/v1/app. One try, a 10 s timeout, no
// retries, no cookies, every error swallowed: it never gets in the way,
// least of all offline.
//
// On by default; Settings → Privacy → "Usage & health stats" turns it off
// (this device only: it's not one of the synced preferences). The web build
// starts off when the browser sends Do Not Track or Global Privacy Control,
// until the switch is turned on.
//
// Dev servers (vite) and e2e builds never send unless VITE_TELEMETRY_URL
// points them somewhere; VITE_TELEMETRY_URL=off turns it off in any build.

import { bucket, type Bucket } from './buckets';

export const DEFAULT_TELEMETRY_URL = 'https://telemetry.boson.chat';
export const PRIVACY_URL = 'https://boson.chat/telemetry';
export const PING_INTERVAL_MS = 24 * 60 * 60 * 1000;
export const SEND_TIMEOUT_MS = 10_000;
export const MAX_CRASHES = 1000;
// Startup: give the app a moment to connect its servers before counting them.
export const STARTUP_DELAY_MS = 30_000;

const STORAGE_KEY = 'boson:telemetry:v1';

export type Platform = 'macos' | 'windows' | 'linux' | 'ios' | 'android' | 'web';
export type Channel = 'stable' | 'beta' | 'dev';

export interface AppPing {
  schema: 1;
  device_id: string;
  app_version: string;
  platform: Platform;
  channel: Channel;
  crashes: number;
  servers: Bucket;
}

// What's kept on the device (localStorage: the app's data dir on desktop,
// app storage on the phones). `enabled` is only there once the switch has
// been used: until then the default applies.
interface Stored {
  enabled?: boolean;
  deviceId?: string;
  lastAttempt?: number;
  crashes?: number;
}

function storage(): Storage | null {
  try { return (globalThis as { localStorage?: Storage }).localStorage ?? null; } catch { return null; }
}

function load(): Stored {
  try {
    const raw = storage()?.getItem(STORAGE_KEY);
    const v = raw ? JSON.parse(raw) as unknown : null;
    return v && typeof v === 'object' ? v as Stored : {};
  } catch { return {}; }
}

function save(patch: Partial<Stored>): void {
  try { storage()?.setItem(STORAGE_KEY, JSON.stringify({ ...load(), ...patch })); } catch { /* best-effort */ }
}

interface Win {
  bosonShell?: string;
  bosonPlatform?: string;
  bosonE2E?: unknown;
}
function win(): Win {
  return (typeof window === 'undefined' ? {} : window) as Win;
}

// The web build: the browser is the platform.
function isWeb(): boolean {
  return win().bosonShell === 'web' || import.meta.env.VITE_BOSON_SHELL === 'web';
}

// ---- the switch ----

// Do Not Track / Global Privacy Control: the web build's default is off.
export function browserOptsOut(nav: { doNotTrack?: string | null; globalPrivacyControl?: boolean } | undefined): boolean {
  if (!nav) return false;
  return nav.doNotTrack === '1' || nav.globalPrivacyControl === true;
}

export function defaultEnabled(web = isWeb(), nav: Parameters<typeof browserOptsOut>[0] = typeof navigator === 'undefined' ? undefined : navigator as never): boolean {
  return !(web && browserOptsOut(nav));
}

export function isTelemetryEnabled(): boolean {
  const e = load().enabled;
  return typeof e === 'boolean' ? e : defaultEnabled();
}

// The switch (Settings → Privacy): an explicit choice, kept from then on.
// Off takes effect at once: the next due check sees it.
export function setTelemetryEnabled(on: boolean): void {
  save({ enabled: on });
}

// ---- what's sent ----

// 128 random bits as 32 lowercase hex, made once and kept. Not derived from
// anything (not the push token, no hardware ID).
export function deviceId(): string {
  const have = load().deviceId;
  if (typeof have === 'string' && /^[0-9a-f]{32}$/.test(have)) return have;
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  const id = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  save({ deviceId: id });
  return id;
}

// The shell's platform (platform/wails.ts: darwin, win32, linux, ios,
// android); the web build, or no shell at all (a browser), is web. Other
// desktops (the BSDs) count as linux: the schema has no other.
export function platformOf(shell: string | undefined, raw: string | undefined): Platform {
  if (shell === 'web' || !raw) return 'web';
  const p = raw.toLowerCase();
  if (p === 'ios') return 'ios';
  if (p === 'android') return 'android';
  if (p === 'darwin' || p === 'macos') return 'macos';
  if (p === 'win32' || p === 'windows') return 'windows';
  return 'linux';
}

// dev: a development server or an e2e build; beta: a pre-release version
// (1.2.3-beta.1); stable otherwise (every release from main).
export function channelOf(version: string, dev: boolean): Channel {
  if (dev) return 'dev';
  return /^v?\d+\.\d+\.\d+-/.test(version) ? 'beta' : 'stable';
}

const VERSION_RE = /^v?[0-9]{1,4}\.[0-9]{1,4}\.[0-9]{1,6}(-[0-9A-Za-z.]{1,32})?$/;
// Build metadata (+…) isn't allowed; neither is anything not a version.
export function normaliseVersion(v: string): string | null {
  const s = v.split('+')[0]!.trim();
  return VERSION_RE.test(s) && s.length <= 64 ? s : null;
}

export function buildPing(p: { deviceId: string; version: string; platform: Platform; channel: Channel; crashes: number; servers: number }): AppPing | null {
  const version = normaliseVersion(p.version);
  if (!version) return null;
  const crashes = Math.max(0, Math.min(MAX_CRASHES, Math.floor(p.crashes) || 0));
  return {
    schema: 1,
    device_id: p.deviceId,
    app_version: version,
    platform: p.platform,
    channel: p.channel,
    crashes,
    servers: bucket(p.servers),
  };
}

// ---- crashes ----

export function crashCount(): number {
  const n = load().crashes;
  return typeof n === 'number' && n > 0 ? Math.min(MAX_CRASHES, Math.floor(n)) : 0;
}

// An uncaught error, an unhandled rejection, the engine session dying under
// the page: one more crash for the next ping. Capped (and no more writes)
// at MAX_CRASHES. Not counted while the stats are off.
export function noteCrash(): void {
  try {
    if (!isTelemetryEnabled()) return;
    const n = crashCount();
    if (n >= MAX_CRASHES) return;
    save({ crashes: n + 1 });
  } catch { /* never let counting a crash cause one */ }
}

// ---- sending ----

export interface PingerDeps {
  /** Base URL (no trailing /v1/app); null: never send. */
  url: string | null;
  version: string;
  platform: Platform;
  channel: Channel;
  /** Servers (networks) connected right now. */
  servers: () => number;
  now?: () => number;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export class TelemetryPinger {
  private inFlight = false;
  constructor(private readonly deps: PingerDeps) {}

  /** Whether a ping is due now (enabled, a URL, 24 h since the last attempt). */
  due(): boolean {
    if (!this.deps.url || !isTelemetryEnabled()) return false;
    const last = load().lastAttempt;
    const now = this.now();
    // A clock that went backwards (or a stored time in the future) doesn't
    // block pings for good.
    return typeof last !== 'number' || now - last >= PING_INTERVAL_MS || now < last;
  }

  /** Sends the ping if one is due. Resolves true when one was sent (any status). Never throws. */
  async maybePing(): Promise<boolean> {
    if (this.inFlight) return false;
    try {
      if (!this.due()) return false;
      let servers = 0;
      try { servers = this.deps.servers(); } catch { servers = 0; }
      const crashes = crashCount();
      const ping = buildPing({ deviceId: deviceId(), version: this.deps.version, platform: this.deps.platform, channel: this.deps.channel, crashes, servers });
      // The attempt counts whatever happens next: no retry until tomorrow.
      save({ lastAttempt: this.now() });
      if (!ping) return false;
      this.inFlight = true;
      const ok = await this.send(ping);
      // Only the crashes this ping reported: any counted while it was in
      // flight stay for the next one.
      if (ok) save({ crashes: Math.max(0, crashCount() - crashes) });
      return ok;
    } catch {
      return false;
    } finally {
      this.inFlight = false;
    }
  }

  private now(): number { return (this.deps.now ?? Date.now)(); }

  private async send(ping: AppPing): Promise<boolean> {
    const f = this.deps.fetch ?? (typeof fetch === 'undefined' ? undefined : fetch.bind(globalThis));
    if (!f) return false;
    const ctl = typeof AbortController === 'undefined' ? null : new AbortController();
    const timer = ctl ? setTimeout(() => ctl.abort(), this.deps.timeoutMs ?? SEND_TIMEOUT_MS) : null;
    try {
      const res = await f(`${this.deps.url!.replace(/\/+$/, '')}/v1/app`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(ping),
        credentials: 'omit',
        cache: 'no-store',
        referrerPolicy: 'no-referrer',
        signal: ctl?.signal,
      });
      // Any answer from the receiver is the end of it (never a retry); the
      // count was delivered when it was accepted.
      return res.status === 202 || res.ok;
    } catch {
      return false;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}

// The base URL for this build: VITE_TELEMETRY_URL when set ("off": none),
// else nothing for dev servers and e2e builds, else telemetry.boson.chat.
export function telemetryUrl(env: { url?: string; dev: boolean; e2e: boolean }): string | null {
  const u = env.url?.trim();
  if (u) return u === 'off' ? null : u;
  return env.dev || env.e2e ? null : DEFAULT_TELEMETRY_URL;
}

// Wires the ping into the running app (main.tsx, once the shell's bridges
// say which platform this is). Returns a function that undoes it.
export function startTelemetry(opts: { version: string; servers: () => number }): () => void {
  const w = win();
  const e2e = 'bosonE2E' in w;
  const dev = import.meta.env.DEV || e2e;
  const pinger = new TelemetryPinger({
    url: telemetryUrl({ url: import.meta.env.VITE_TELEMETRY_URL, dev: import.meta.env.DEV, e2e }),
    version: opts.version,
    platform: platformOf(w.bosonShell, w.bosonPlatform),
    channel: channelOf(opts.version, dev),
    servers: opts.servers,
  });
  const ping = (): void => { void pinger.maybePing(); };
  const startup = setTimeout(ping, STARTUP_DELAY_MS);
  const visible = (): void => { if (document.visibilityState === 'visible') ping(); };
  document.addEventListener('visibilitychange', visible);
  window.addEventListener('focus', ping);
  return () => {
    clearTimeout(startup);
    document.removeEventListener('visibilitychange', visible);
    window.removeEventListener('focus', ping);
  };
}

// Uncaught errors and unhandled rejections in the page (main.tsx, first
// thing). Renderer/engine session crashes are counted where they're seen
// (platform/wails.ts).
export function countCrashes(target: Pick<Window, 'addEventListener' | 'removeEventListener'> = window): () => void {
  const onError = (): void => noteCrash();
  target.addEventListener('error', onError);
  target.addEventListener('unhandledrejection', onError);
  return () => {
    target.removeEventListener('error', onError);
    target.removeEventListener('unhandledrejection', onError);
  };
}
