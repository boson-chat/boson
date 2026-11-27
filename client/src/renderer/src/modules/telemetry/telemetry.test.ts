import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { BUCKETS, bucket } from './buckets';
import {
  MAX_CRASHES, PING_INTERVAL_MS, TelemetryPinger, buildPing, browserOptsOut, channelOf, countCrashes,
  crashCount, defaultEnabled, deviceId, isTelemetryEnabled, noteCrash, normaliseVersion, platformOf,
  setTelemetryEnabled, telemetryUrl, type PingerDeps,
} from './telemetry';

const KEY = 'boson:telemetry:v1';
const stored = (): Record<string, unknown> => JSON.parse(localStorage.getItem(KEY) ?? '{}');

// The app ping's JSON Schema (boson-chat/stack docs/telemetry.md), checked by hand.
const FIELDS = ['schema', 'device_id', 'app_version', 'platform', 'channel', 'crashes', 'servers'];
function assertSchema(body: unknown): void {
  expect(body).toBeTypeOf('object');
  const o = body as Record<string, unknown>;
  expect(Object.keys(o).sort()).toEqual([...FIELDS].sort());
  expect(o.schema).toBe(1);
  expect(o.device_id).toMatch(/^[0-9a-f]{32}$/);
  expect(typeof o.app_version).toBe('string');
  expect((o.app_version as string).length).toBeLessThanOrEqual(64);
  expect(o.app_version).toMatch(/^v?[0-9]{1,4}\.[0-9]{1,4}\.[0-9]{1,6}(-[0-9A-Za-z.]{1,32})?$/);
  expect(['macos', 'windows', 'linux', 'ios', 'android', 'web']).toContain(o.platform);
  expect(['stable', 'beta', 'dev']).toContain(o.channel);
  expect(Number.isInteger(o.crashes)).toBe(true);
  expect(o.crashes as number).toBeGreaterThanOrEqual(0);
  expect(o.crashes as number).toBeLessThanOrEqual(1000);
  expect(BUCKETS).toContain(o.servers);
}

beforeEach(() => { localStorage.removeItem(KEY); });

describe('bucket', () => {
  it.each([
    [0, '0'], [-3, '0'], [Number.NaN, '0'],
    [1, '1'],
    [2, '2-10'], [10, '2-10'],
    [11, '11-50'], [50, '11-50'],
    [51, '51-100'], [100, '51-100'],
    [101, '101-500'], [500, '101-500'],
    [501, '501-1k'], [1000, '501-1k'],
    [1001, '1k-5k'], [5000, '1k-5k'],
    [5001, '5k+'], [1e9, '5k+'], [Infinity, '5k+'],
  ])('%s → %s', (n, b) => {
    expect(bucket(n)).toBe(b);
  });
});

describe('the switch', () => {
  it('is on by default on the apps, whatever the browser says', () => {
    expect(defaultEnabled(false, { doNotTrack: '1', globalPrivacyControl: true })).toBe(true);
  });

  it('starts off on the web with Do Not Track or Global Privacy Control', () => {
    expect(browserOptsOut({ doNotTrack: '1' })).toBe(true);
    expect(browserOptsOut({ globalPrivacyControl: true })).toBe(true);
    expect(browserOptsOut({ doNotTrack: '0', globalPrivacyControl: false })).toBe(false);
    expect(browserOptsOut({ doNotTrack: null })).toBe(false);
    expect(browserOptsOut(undefined)).toBe(false);
    expect(defaultEnabled(true, { doNotTrack: '1' })).toBe(false);
    expect(defaultEnabled(true, { globalPrivacyControl: true })).toBe(false);
    expect(defaultEnabled(true, {})).toBe(true);
  });

  it('keeps an explicit choice over the web default', () => {
    const w = window as unknown as { bosonShell?: string };
    const nav = navigator as unknown as { doNotTrack?: string };
    const had = Object.getOwnPropertyDescriptor(navigator, 'doNotTrack');
    w.bosonShell = 'web';
    Object.defineProperty(navigator, 'doNotTrack', { configurable: true, get: () => '1' });
    try {
      expect(nav.doNotTrack).toBe('1');
      expect(isTelemetryEnabled()).toBe(false);
      setTelemetryEnabled(true);
      expect(isTelemetryEnabled()).toBe(true);
      expect(stored().enabled).toBe(true);
      setTelemetryEnabled(false);
      expect(isTelemetryEnabled()).toBe(false);
    } finally {
      delete w.bosonShell;
      if (had) Object.defineProperty(navigator, 'doNotTrack', had);
      else delete (navigator as unknown as { doNotTrack?: string }).doNotTrack;
    }
  });
});

describe('what is sent', () => {
  it('device_id: 32 random lowercase hex, made once', () => {
    const a = deviceId();
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(deviceId()).toBe(a);
    localStorage.removeItem(KEY);
    expect(deviceId()).not.toBe(a);
  });

  it.each([
    ['web', 'darwin', 'web'], [undefined, undefined, 'web'],
    [undefined, 'darwin', 'macos'], [undefined, 'win32', 'windows'], [undefined, 'windows', 'windows'],
    [undefined, 'linux', 'linux'], [undefined, 'freebsd', 'linux'],
    [undefined, 'ios', 'ios'], [undefined, 'android', 'android'],
  ])('platform: shell %s, %s → %s', (shell, raw, p) => {
    expect(platformOf(shell, raw)).toBe(p);
  });

  it('channel: dev builds, pre-releases, releases', () => {
    expect(channelOf('0.105.2', true)).toBe('dev');
    expect(channelOf('0.106.0-beta.1', false)).toBe('beta');
    expect(channelOf('0.105.2', false)).toBe('stable');
  });

  it('versions: build metadata is dropped, anything else not a version is not sent', () => {
    expect(normaliseVersion('1.2.3+abc')).toBe('1.2.3');
    expect(normaliseVersion('v1.2.3-rc.1')).toBe('v1.2.3-rc.1');
    expect(normaliseVersion('latest')).toBeNull();
    expect(buildPing({ deviceId: 'a'.repeat(32), version: 'dev', platform: 'web', channel: 'dev', crashes: 0, servers: 0 })).toBeNull();
  });

  it('exactly the schema’s fields', () => {
    const p = buildPing({ deviceId: deviceId(), version: '0.105.2', platform: 'macos', channel: 'stable', crashes: 5000, servers: 3 });
    assertSchema(p);
    expect(p).toEqual(expect.objectContaining({ crashes: 1000, servers: '2-10' }));
  });

  it('the URL: overridable, off in dev and e2e builds unless pointed somewhere', () => {
    expect(telemetryUrl({ dev: false, e2e: false })).toBe('https://telemetry.boson.chat');
    expect(telemetryUrl({ dev: true, e2e: false })).toBeNull();
    expect(telemetryUrl({ dev: false, e2e: true })).toBeNull();
    expect(telemetryUrl({ url: 'http://127.0.0.1:8080', dev: true, e2e: false })).toBe('http://127.0.0.1:8080');
    expect(telemetryUrl({ url: 'off', dev: false, e2e: false })).toBeNull();
  });
});

describe('crashes', () => {
  it('counts uncaught errors and unhandled rejections, kept across restarts, capped', () => {
    const off = countCrashes();
    window.dispatchEvent(new Event('error'));
    window.dispatchEvent(new Event('unhandledrejection'));
    off();
    window.dispatchEvent(new Event('error'));
    expect(crashCount()).toBe(2);
    expect(stored().crashes).toBe(2);
    localStorage.setItem(KEY, JSON.stringify({ ...stored(), crashes: MAX_CRASHES - 1 }));
    noteCrash(); noteCrash(); noteCrash();
    expect(crashCount()).toBe(MAX_CRASHES);
  });

  it('are not counted while the stats are off', () => {
    setTelemetryEnabled(false);
    noteCrash();
    expect(crashCount()).toBe(0);
  });
});

describe('TelemetryPinger', () => {
  let now = 0;
  let fetchMock: ReturnType<typeof vi.fn>;
  const make = (over: Partial<PingerDeps> = {}) => new TelemetryPinger({
    url: 'https://telemetry.example',
    version: '0.105.2',
    platform: 'linux',
    channel: 'stable',
    servers: () => 1,
    now: () => now,
    fetch: fetchMock as unknown as typeof fetch,
    ...over,
  });

  beforeEach(() => {
    now = 1_800_000_000_000;
    fetchMock = vi.fn(async () => new Response('{"ok":true}', { status: 202 }));
  });
  afterEach(() => { vi.useRealTimers(); });

  it('sends once a day: the first time, then not again for 24 h, then again', async () => {
    const p = make();
    expect(await p.maybePing()).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    now += PING_INTERVAL_MS - 1;
    expect(await p.maybePing()).toBe(false);
    // A restart doesn't reset it: the attempt time is kept.
    expect(await make().maybePing()).toBe(false);
    now += 1;
    expect(await p.maybePing()).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('a failed attempt counts too: no retry until tomorrow', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('offline'));
    const p = make();
    expect(await p.maybePing()).toBe(false);
    now += 60_000;
    expect(await p.maybePing()).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(stored().lastAttempt).toBe(now - 60_000);
  });

  it('a clock that went backwards doesn’t block pings for good', async () => {
    await make().maybePing();
    now -= 5 * PING_INTERVAL_MS;
    expect(await make().maybePing()).toBe(true);
  });

  it('POSTs exactly the schema to <url>/v1/app, no credentials, with a timeout', async () => {
    noteCrash();
    await make({ url: 'https://telemetry.example/', servers: () => 12 }).maybePing();
    const [url, init] = fetchMock.mock.calls[0]! as [string, RequestInit];
    expect(url).toBe('https://telemetry.example/v1/app');
    expect(init.method).toBe('POST');
    expect(init.credentials).toBe('omit');
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
    expect(init.signal).toBeInstanceOf(AbortSignal);
    const body = JSON.parse(init.body as string);
    assertSchema(body);
    expect(body).toEqual({ schema: 1, device_id: deviceId(), app_version: '0.105.2', platform: 'linux', channel: 'stable', crashes: 1, servers: '11-50' });
    expect((init.body as string).length).toBeLessThan(2048);
  });

  it('off: nothing is sent, from the moment it’s switched off', async () => {
    setTelemetryEnabled(false);
    expect(await make().maybePing()).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
    setTelemetryEnabled(true);
    expect(await make().maybePing()).toBe(true);
  });

  it('no URL (dev, e2e, VITE_TELEMETRY_URL=off): nothing is sent', async () => {
    expect(await make({ url: null }).maybePing()).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('resets the crash count after a sent ping, keeping crashes counted meanwhile', async () => {
    noteCrash(); noteCrash();
    let release!: (r: Response) => void;
    fetchMock.mockImplementationOnce(() => new Promise<Response>((r) => { release = r; }));
    const sent = make().maybePing();
    await Promise.resolve();
    noteCrash();
    release(new Response('', { status: 202 }));
    expect(await sent).toBe(true);
    expect(JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string).crashes).toBe(2);
    expect(crashCount()).toBe(1);
  });

  it('keeps the crash count when the ping wasn’t accepted', async () => {
    noteCrash();
    fetchMock.mockResolvedValueOnce(new Response('{"ok":false}', { status: 429 }));
    expect(await make().maybePing()).toBe(false);
    expect(crashCount()).toBe(1);
  });

  it('swallows every failure: a throwing fetch, a throwing server count, storage that throws', async () => {
    fetchMock.mockImplementationOnce(() => { throw new Error('boom'); });
    await expect(make({ servers: () => { throw new Error('nope'); } }).maybePing()).resolves.toBe(false);
    const spy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('denied'); });
    const ls = localStorage.getItem;
    localStorage.getItem = () => { throw new Error('denied'); };
    try {
      now += 2 * PING_INTERVAL_MS;
      await expect(make().maybePing()).resolves.toBeTypeOf('boolean');
      expect(() => noteCrash()).not.toThrow();
    } finally {
      localStorage.getItem = ls;
      spy.mockRestore();
    }
  });

  it('gives up after the timeout', async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementationOnce((_u: string, init: RequestInit) => new Promise((_r, reject) => {
      init.signal!.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    }));
    const sent = make({ timeoutMs: 10_000 }).maybePing();
    await vi.advanceTimersByTimeAsync(10_000);
    await expect(sent).resolves.toBe(false);
  });

  it('one at a time: a check while a ping is in flight does nothing', async () => {
    let release!: (r: Response) => void;
    fetchMock.mockImplementationOnce(() => new Promise<Response>((r) => { release = r; }));
    const p = make();
    const first = p.maybePing();
    expect(await p.maybePing()).toBe(false);
    release(new Response('', { status: 202 }));
    await first;
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
