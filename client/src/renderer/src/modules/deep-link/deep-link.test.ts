import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  parseJoinUrl,
  parseAuthConfirmedUrl,
  subscribeDeepLink,
  __resetDeepLinkForTests,
  initDeepLinkBridge,
} from './deep-link';

beforeEach(() => {
  __resetDeepLinkForTests();
});

afterEach(() => {
  __resetDeepLinkForTests();
  vi.useRealTimers();
  delete (window as unknown as Record<string, unknown>).bosonDeepLink;
});

describe('parseJoinUrl', () => {
  it('parses host/port/tls/name out of a boson://join URL', () => {
    const r = parseJoinUrl('boson://join?host=irc.example.com&port=6697&tls=1&name=Example');
    expect(r).toEqual({ host: 'irc.example.com', port: 6697, tls: true, name: 'Example' });
  });

  it('defaults port to 6697 and tls to true when params are omitted', () => {
    const r = parseJoinUrl('boson://join?host=irc.example.com');
    expect(r).toEqual({ host: 'irc.example.com', port: 6697, tls: true });
  });

  it('returns null for non-join verbs or non-boson schemes', () => {
    expect(parseJoinUrl('boson://auth/confirmed#access_token=x')).toBeNull();
    expect(parseJoinUrl('https://example.com/join?host=irc.example.com')).toBeNull();
    expect(parseJoinUrl('boson://join?port=6697')).toBeNull(); // host required
  });
});

describe('parseAuthConfirmedUrl state nonce', () => {
  it('parses the state nonce from the query string', () => {
    const p = parseAuthConfirmedUrl(
      'boson://auth/confirmed?state=abc123&access_token=tok&type=signup',
    );
    expect(p?.state).toBe('abc123');
    expect(p?.accessToken).toBe('tok');
  });

  it('also accepts state carried in the fragment', () => {
    const p = parseAuthConfirmedUrl(
      'boson://auth/confirmed#access_token=tok&state=fromhash',
    );
    expect(p?.accessToken).toBe('tok');
    expect(p?.state).toBe('fromhash');
  });

  it('leaves state undefined when the URL carries none (forged deep-link)', () => {
    const p = parseAuthConfirmedUrl('boson://auth/confirmed#access_token=tok&refresh_token=r');
    expect(p).not.toBeNull();
    expect(p?.state).toBeUndefined();
  });
});

describe('subscribeDeepLink buffering + dedupe', () => {
  it('replays a buffered URL synchronously when a subscriber arrives', () => {
    // Wire up the bridge with an immediate consume() that returns a URL —
    // simulates the cold-start path where main has the URL waiting.
    const url = 'boson://join?host=irc.example.com&port=6697&tls=1';
    (window as unknown as Record<string, unknown>).bosonDeepLink = {
      consume: async () => url,
      onJoin: (_fn: (u: string) => void) => () => {},
    };
    initDeepLinkBridge();
    return Promise.resolve().then(() => {
      // After consume() resolves, the URL is buffered awaiting a subscriber.
      const seen: Array<{ host: string; port: number }> = [];
      const off = subscribeDeepLink((p) => {
        seen.push({ host: p.host, port: p.port });
      });
      expect(seen).toEqual([{ host: 'irc.example.com', port: 6697 }]);
      off();
    });
  });

  it('dedupes the same URL arriving via both consume() and live onJoin', async () => {
    // This is the cold-start scenario the main process now hardens
    // against: main both buffers and best-effort live-sends, so the
    // renderer can see the same URL twice. The dedupe guard means
    // we only fire the listener once.
    let liveSend: ((u: string) => void) | null = null;
    const url = 'boson://join?host=irc.example.com&port=6697&tls=1';
    (window as unknown as Record<string, unknown>).bosonDeepLink = {
      consume: async () => url,
      onJoin: (fn: (u: string) => void) => {
        liveSend = fn;
        return () => { liveSend = null; };
      },
    };
    const fires: string[] = [];
    subscribeDeepLink((p) => { fires.push(p.host); });
    initDeepLinkBridge();
    // Allow the consume() promise to resolve.
    await Promise.resolve();
    await Promise.resolve();
    // Now main fires the live event with the same URL.
    liveSend!(url);
    expect(fires).toEqual(['irc.example.com']);
  });

  it('allows the same URL after the dedupe window expires', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-28T00:00:00Z'));
    let liveSend: ((u: string) => void) | null = null;
    const url = 'boson://join?host=irc.example.com&port=6697&tls=1';
    (window as unknown as Record<string, unknown>).bosonDeepLink = {
      consume: async () => null,
      onJoin: (fn: (u: string) => void) => {
        liveSend = fn;
        return () => { liveSend = null; };
      },
    };
    const fires: string[] = [];
    subscribeDeepLink((p) => { fires.push(p.host); });
    initDeepLinkBridge();
    await Promise.resolve();
    liveSend!(url);
    expect(fires).toHaveLength(1);
    // Past the dedupe window → re-click is honoured.
    vi.setSystemTime(new Date('2026-05-28T00:00:02Z'));
    liveSend!(url);
    expect(fires).toHaveLength(2);
  });
});
