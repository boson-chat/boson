import { describe, expect, it, vi } from 'vitest';
import { webUnfurlBridges } from './unfurl';

function fakeFetch(status: number, body: unknown) {
  return vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify(body), { status }));
}

describe('web unfurl bridges', () => {
  it('asks the API for a card and returns it', async () => {
    const f = fakeFetch(200, { url: 'https://e.com/', title: 'T' });
    const b = webUnfurlBridges('https://api.example.org/', f as unknown as typeof fetch);
    expect(await b.unfurl.fetch('https://e.com/a b?x=1&y')).toEqual({ url: 'https://e.com/', title: 'T' });
    const [url, init] = f.mock.calls[0]!;
    expect(url).toBe('https://api.example.org/v1/unfurl?url=' + encodeURIComponent('https://e.com/a b?x=1&y'));
    expect(init).toMatchObject({ credentials: 'omit', headers: { Accept: 'application/json' } });
    expect((init!.headers as Record<string, string>)['Authorization']).toBeUndefined();
  });

  it('sends the signed-in token, and Spotify links to /v1/unfurl/spotify', async () => {
    const f = fakeFetch(200, { url: 'u', type: 'track', title: 'S' });
    const b = webUnfurlBridges('https://api.example.org', f as unknown as typeof fetch);
    b.unfurl.setTokenSource(async () => 'tok');
    expect(await b.spotify.fetch('https://open.spotify.com/track/x')).toMatchObject({ title: 'S' });
    const [url, init] = f.mock.calls[0]!;
    expect(url).toBe('https://api.example.org/v1/unfurl/spotify?url=' + encodeURIComponent('https://open.spotify.com/track/x'));
    expect((init!.headers as Record<string, string>)['Authorization']).toBe('Bearer tok');
    // A token source that fails: asked anonymously.
    b.unfurl.setTokenSource(async () => { throw new Error('locked'); });
    await b.unfurl.fetch('https://e.com/');
    expect((f.mock.calls[1]![1]!.headers as Record<string, string>)['Authorization']).toBeUndefined();
  });

  it('is null for no preview, refusals, rate limits, network errors and non-http links', async () => {
    for (const status of [404, 400, 429, 500]) {
      expect(await webUnfurlBridges('https://a', fakeFetch(status, { error: 'x' }) as unknown as typeof fetch).unfurl.fetch('https://e.com/')).toBeNull();
    }
    const down = vi.fn(async () => { throw new TypeError('Failed to fetch'); });
    expect(await webUnfurlBridges('https://a', down as unknown as typeof fetch).spotify.fetch('https://open.spotify.com/track/x')).toBeNull();
    const never = vi.fn();
    const b = webUnfurlBridges('https://a', never as unknown as typeof fetch);
    expect(await b.unfurl.fetch('javascript:alert(1)')).toBeNull();
    expect(await b.unfurl.fetch('not a url')).toBeNull();
    expect(never).not.toHaveBeenCalled();
  });
});
