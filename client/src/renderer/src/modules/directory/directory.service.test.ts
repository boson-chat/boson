import { describe, it, expect, beforeEach } from 'vitest';
import { DirectoryService } from './directory.service';
import { HttpClient, HttpError, type TokenProvider } from '../../shared/http/http.client';
import type { Server, User } from './directory.types';

class StaticToken implements TokenProvider {
  async getToken(): Promise<string | null> { return 'jwt'; }
}

function mockResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('DirectoryService', () => {
  let svc: DirectoryService;
  let calls: Array<[string, RequestInit | undefined]>;

  beforeEach(() => {
    calls = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push([input as string, init]);
      const url = String(input);

      if (url.endsWith('/me') && (!init || init.method === 'GET')) {
        return mockResponse({ id: '1', handle: 'alice', is_discoverable: true, encrypted_user_secret: '', created_at: '2026-01-01' });
      }
      if (url.endsWith('/me') && init?.method === 'POST') {
        const u: User = { id: '1', handle: JSON.parse(init.body as string).handle, is_discoverable: true, encrypted_user_secret: '', created_at: '2026-01-01' };
        return mockResponse(u, 201);
      }
      if (url.includes('/servers')) {
        const s: Server = {
          id: '1', hostname: 'irc', port: 6697, tls: true, name: 'Test',
          tags: [], languages: [], is_nsfw: false, is_featured: false,
          verification_status: 'pending', health_status: 'unknown',
          registered_at: '2026-01-01',
        };
        return mockResponse({ servers: [s], count: 1 });
      }
      return new Response('not found', { status: 404 });
    }) as typeof fetch;

    svc = new DirectoryService(new HttpClient('http://api', new StaticToken()));
  });

  it('listServers builds query string from params', async () => {
    await svc.listServers({ q: 'foss', lang: 'en', nsfw: true, sort: 'newest' });
    const [url] = calls[0];
    expect(url).toContain('q=foss');
    expect(url).toContain('lang=en');
    expect(url).toContain('nsfw=true');
    expect(url).toContain('sort=newest');
  });

  it('listServers omits empty params', async () => {
    await svc.listServers({});
    const [url] = calls[0];
    expect(url).toBe('http://api/servers');
  });

  it('listServers unwraps the {servers, count} envelope', async () => {
    const servers = await svc.listServers();
    expect(servers).toHaveLength(1);
    expect(servers[0]!.name).toBe('Test');
  });

  it('getMe returns user when 200', async () => {
    const me = await svc.getMe();
    expect(me).toEqual(expect.objectContaining({ handle: 'alice' }));
  });

  it('getMe returns null on 404 (needs_setup)', async () => {
    globalThis.fetch = (async () => mockResponse({ status: 'needs_setup' }, 404)) as typeof fetch;
    const me = await svc.getMe();
    expect(me).toBeNull();
  });

  it('getMe rethrows non-404 errors', async () => {
    globalThis.fetch = (async () => mockResponse({ error: 'server down' }, 500)) as typeof fetch;
    await expect(svc.getMe()).rejects.toBeInstanceOf(HttpError);
  });

  it('setupMe POSTs handle and base64 secret', async () => {
    const u = await svc.setupMe('bob', 'YWJjZA==');
    expect(u.handle).toBe('bob');
    const [, init] = calls[0];
    expect(init?.method).toBe('POST');
    expect(JSON.parse(init!.body as string)).toEqual({
      handle: 'bob',
      encrypted_user_secret: 'YWJjZA==',
    });
  });

  it('deleteMe issues DELETE /me', async () => {
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push([input as string, init]);
      return new Response(null, { status: 204 });
    }) as typeof fetch;
    await svc.deleteMe();
    const [url, init] = calls[0];
    expect(url).toBe('http://api/me');
    expect(init?.method).toBe('DELETE');
  });

  it('updateMe PATCHes /me with the supplied handle', async () => {
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push([input as string, init]);
      return mockResponse({
        id: '1', handle: 'renamed', is_discoverable: true,
        encrypted_user_secret: '', created_at: '2026-01-01',
      });
    }) as typeof fetch;

    const updated = await svc.updateMe({ handle: 'renamed' });
    expect(updated.handle).toBe('renamed');
    const [url, init] = calls[0];
    expect(url).toBe('http://api/me');
    expect(init?.method).toBe('PATCH');
    expect(JSON.parse(init!.body as string)).toEqual({ handle: 'renamed' });
  });

  it('updateMe surfaces 409 (handle taken) as HttpError', async () => {
    globalThis.fetch = (async () => mockResponse({ error: 'handle taken' }, 409)) as typeof fetch;
    await expect(svc.updateMe({ handle: 'taken' })).rejects.toMatchObject({
      status: 409,
    });
  });

  it('updateMe surfaces 400 (too short) as HttpError', async () => {
    globalThis.fetch = (async () => mockResponse({ error: 'handle must be at least 3 characters' }, 400)) as typeof fetch;
    await expect(svc.updateMe({ handle: 'ab' })).rejects.toMatchObject({
      status: 400,
    });
  });
});
