import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fetchTransport, defaultApiTransport } from './transport';

describe('transport', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    delete (window as { bosonApi?: unknown }).bosonApi;
  });

  it('fetchTransport calls fetch and normalizes the response', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('hi', { status: 201, statusText: 'Created' }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const res = await fetchTransport({ method: 'POST', url: 'https://x/y', headers: { a: 'b' }, body: 'payload' });
    expect(res).toEqual({ status: 201, ok: true, statusText: 'Created', text: 'hi' });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://x/y');
    expect((init as RequestInit).body).toBe('payload');
  });

  describe('defaultApiTransport', () => {
    beforeEach(() => { delete (window as { bosonApi?: unknown }).bosonApi; });

    it('uses the Electron bridge when present', async () => {
      const bridgeFetch = vi.fn().mockResolvedValue({ status: 200, ok: true, statusText: 'OK', text: '{}' });
      (window as { bosonApi?: unknown }).bosonApi = { fetch: bridgeFetch };
      const t = defaultApiTransport();
      await t({ method: 'GET', url: 'https://api/x', headers: {} });
      expect(bridgeFetch).toHaveBeenCalledOnce();
    });

    it('falls back to fetch when the bridge is absent', async () => {
      const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
      globalThis.fetch = fetchMock as unknown as typeof fetch;
      const t = defaultApiTransport();
      await t({ method: 'GET', url: 'https://api/x', headers: {} });
      expect(fetchMock).toHaveBeenCalledOnce();
    });
  });
});
