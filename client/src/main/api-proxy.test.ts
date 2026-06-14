import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { proxyApiFetch } from './api-proxy';

describe('proxyApiFetch', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
  });
  afterEach(() => vi.restoreAllMocks());

  it('proxies an allowed https request and returns status + text', async () => {
    fetchMock.mockResolvedValueOnce(new Response('{"ok":true}', { status: 200, statusText: 'OK' }));
    const res = await proxyApiFetch({ method: 'GET', url: 'https://api.boson.chat/me', headers: { Authorization: 'Bearer x' } });
    expect(res).toEqual({ status: 200, ok: true, statusText: 'OK', text: '{"ok":true}' });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.boson.chat/me');
    expect((init as RequestInit).method).toBe('GET');
    expect((init as RequestInit).headers).toMatchObject({ Authorization: 'Bearer x' });
  });

  it('allows loopback (local dev backend) over http', async () => {
    fetchMock.mockResolvedValueOnce(new Response('{}', { status: 200 }));
    await proxyApiFetch({ method: 'GET', url: 'http://localhost:8080/me' });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('blocks private / link-local / non-https public hosts without fetching', async () => {
    for (const url of [
      'http://api.boson.chat/me',        // public must be https
      'https://192.168.1.10/x',          // private LAN
      'https://169.254.169.254/latest',  // cloud metadata
      'https://10.0.0.1/x',              // private
      'ftp://api.boson.chat/x',          // bad scheme
    ]) {
      const res = await proxyApiFetch({ method: 'GET', url });
      expect(res.ok).toBe(false);
      expect(res.status).toBe(0);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('forwards a binary body and reports network failure gracefully', async () => {
    fetchMock.mockRejectedValueOnce(new Error('boom'));
    const res = await proxyApiFetch({ method: 'POST', url: 'https://api.boson.chat/avatar', body: new ArrayBuffer(8) });
    expect(res).toMatchObject({ ok: false, status: 0, statusText: 'boom' });
  });

  it('rejects a malformed request', async () => {
    expect((await proxyApiFetch({ method: 'GET', url: 'not a url' })).statusText).toBe('Bad URL');
    // @ts-expect-error intentionally bad shape
    expect((await proxyApiFetch(null)).statusText).toBe('Bad request');
  });
});
