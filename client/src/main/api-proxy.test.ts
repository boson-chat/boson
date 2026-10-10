import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createApiProxyPolicy, proxyApiFetch as rawProxyApiFetch, type ApiProxyRequest } from './api-proxy';

// Packaged-build policy: only the configured API origin, no loopback.
const prodPolicy = createApiProxyPolicy({ apiBase: 'https://api.boson.chat', allowLoopback: false });
// Dev-build policy: configured local backend + any loopback port.
const devPolicy = createApiProxyPolicy({ apiBase: 'http://localhost:3000', allowLoopback: true });
const proxyApiFetch = (req: ApiProxyRequest) => rawProxyApiFetch(req, prodPolicy);

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

  it('allows loopback (local dev backend) over http only in dev', async () => {
    fetchMock.mockResolvedValue(new Response('{}', { status: 200 }));
    await rawProxyApiFetch({ method: 'GET', url: 'http://localhost:8080/me' }, devPolicy);
    await rawProxyApiFetch({ method: 'GET', url: 'http://127.0.0.1:3000/me' }, devPolicy);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // Packaged: loopback is off, so a compromised renderer can't reach
    // other local services (the engine, a dev DB, a router admin page…).
    fetchMock.mockClear();
    for (const url of ['http://localhost:8080/me', 'http://127.0.0.1:3000/me', 'http://[::1]:3000/me']) {
      const res = await proxyApiFetch({ method: 'GET', url });
      expect(res.statusText).toBe('Blocked host');
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('allows the configured API base even when it is loopback', async () => {
    // A build pointed at a local backend still reaches exactly that origin.
    const policy = createApiProxyPolicy({ apiBase: 'http://localhost:3000/', allowLoopback: false });
    fetchMock.mockResolvedValue(new Response('{}', { status: 200 }));
    expect((await rawProxyApiFetch({ method: 'GET', url: 'http://localhost:3000/me' }, policy)).ok).toBe(true);
    expect((await rawProxyApiFetch({ method: 'GET', url: 'http://localhost:3001/me' }, policy)).statusText).toBe('Blocked host');
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('falls back to the production API when no base is configured', async () => {
    const policy = createApiProxyPolicy({ apiBase: undefined, allowLoopback: false });
    fetchMock.mockResolvedValueOnce(new Response('{}', { status: 200 }));
    expect((await rawProxyApiFetch({ method: 'GET', url: 'https://api.boson.chat/me' }, policy)).ok).toBe(true);
  });

  it('blocks everything off the exact-origin allowlist without fetching', async () => {
    for (const url of [
      'http://api.boson.chat/me',            // wrong scheme
      'https://api.boson.chat:8443/me',      // wrong port
      'https://api.boson.chat.evil.com/me',  // suffix trick
      'https://evil.boson.chat/me',          // sibling subdomain
      'https://example.com/x',               // arbitrary public host
      'https://192.168.1.10/x',              // private LAN
      'https://169.254.169.254/latest',      // cloud metadata
      'https://10.0.0.1/x',                  // private
      'ftp://api.boson.chat/x',              // bad scheme
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

  it('refuses a redirect that points at a blocked host without fetching it', async () => {
    // SSRF guard: an allowed host 302s to the cloud-metadata endpoint.
    fetchMock.mockResolvedValueOnce(
      new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/latest/meta-data/' } }),
    );
    const res = await proxyApiFetch({ method: 'GET', url: 'https://api.boson.chat/redir' });
    expect(res.ok).toBe(false);
    expect(res.statusText).toBe('Blocked redirect host');
    // The metadata endpoint is never fetched — only the initial URL was.
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('refuses a redirect to a public host off the allowlist', async () => {
    // Redirects are held to the same allowlist as the initial request, so an
    // open redirect on our API can't bounce the proxy to a third party.
    fetchMock.mockResolvedValueOnce(
      new Response(null, { status: 302, headers: { location: 'https://evil.example.com/x' } }),
    );
    const res = await proxyApiFetch({
      method: 'GET',
      url: 'https://api.boson.chat/start',
      headers: { Authorization: 'Bearer secret' },
    });
    expect(res.statusText).toBe('Blocked redirect host');
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('follows a same-origin redirect and returns the final body', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: '/final' } }))
      .mockResolvedValueOnce(new Response('done', { status: 200, statusText: 'OK' }));
    const res = await proxyApiFetch({ method: 'GET', url: 'https://api.boson.chat/start' });
    expect(res).toMatchObject({ status: 200, ok: true, text: 'done' });
    expect(fetchMock.mock.calls[1][0]).toBe('https://api.boson.chat/final');
  });

  it('strips Authorization/Cookie on a cross-origin redirect between allowed origins', async () => {
    // Dev: the configured backend on :3000 redirects to another loopback port.
    fetchMock
      .mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: 'http://127.0.0.1:9999/x' } }))
      .mockResolvedValueOnce(new Response('ok', { status: 200 }));
    await rawProxyApiFetch({
      method: 'GET',
      url: 'http://localhost:3000/start',
      headers: { Authorization: 'Bearer secret', Cookie: 'sid=1', 'X-Keep': '1' },
    }, devPolicy);
    const secondInit = fetchMock.mock.calls[1][1] as RequestInit;
    expect(secondInit.headers).not.toHaveProperty('Authorization');
    expect(secondInit.headers).not.toHaveProperty('Cookie');
    expect(secondInit.headers).toMatchObject({ 'X-Keep': '1' });
  });

  it('stops after too many redirects', async () => {
    fetchMock.mockResolvedValue(
      new Response(null, { status: 302, headers: { location: 'https://api.boson.chat/loop' } }),
    );
    const res = await proxyApiFetch({ method: 'GET', url: 'https://api.boson.chat/start' });
    expect(res.ok).toBe(false);
    expect(res.statusText).toBe('Too many redirects');
  });

  it('rejects a malformed request', async () => {
    expect((await proxyApiFetch({ method: 'GET', url: 'not a url' })).statusText).toBe('Bad URL');
    // @ts-expect-error intentionally bad shape
    expect((await proxyApiFetch(null)).statusText).toBe('Bad request');
  });
});
