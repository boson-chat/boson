import { describe, it, expect, beforeEach, vi } from 'vitest';
import { HttpClient, HttpError, type TokenProvider } from './http.client';

class StaticTokenProvider implements TokenProvider {
  constructor(private readonly token: string | null) {}
  async getToken(): Promise<string | null> { return this.token; }
}

describe('HttpClient', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
  });

  it('GET attaches bearer token when present', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));

    const client = new HttpClient('http://api.test', new StaticTokenProvider('jwt-token'));
    const result = await client.get<{ ok: boolean }>('/me');

    expect(result).toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://api.test/me');
    expect((init as RequestInit).method).toBe('GET');
    expect((init as RequestInit).headers).toMatchObject({
      'Authorization': 'Bearer jwt-token',
      'Content-Type': 'application/json',
    });
  });

  it('GET omits Authorization header when no token', async () => {
    fetchMock.mockResolvedValueOnce(new Response('{}', { status: 200 }));
    const client = new HttpClient('http://api.test', new StaticTokenProvider(null));
    await client.get('/health');

    const [, init] = fetchMock.mock.calls[0];
    expect((init as RequestInit).headers).not.toHaveProperty('Authorization');
  });

  it('POST serializes body to JSON', async () => {
    fetchMock.mockResolvedValueOnce(new Response('{}', { status: 201 }));
    const client = new HttpClient('http://api.test', new StaticTokenProvider('t'));
    await client.post('/users', { name: 'alice' });

    const [, init] = fetchMock.mock.calls[0];
    expect((init as RequestInit).method).toBe('POST');
    expect((init as RequestInit).body).toBe('{"name":"alice"}');
  });

  it('throws HttpError with parsed JSON body for 4xx', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: 'taken' }), {
      status: 409,
      headers: { 'Content-Type': 'application/json' },
    }));
    const client = new HttpClient('http://api.test', new StaticTokenProvider('t'));

    await expect(client.get('/me')).rejects.toMatchObject({
      status: 409,
      message: 'taken',
    });
  });

  it('HttpError preserves status and body for 404', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ status: 'needs_setup' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    }));
    const client = new HttpClient('http://api.test', new StaticTokenProvider('t'));

    try {
      await client.get('/me');
      expect.fail('expected throw');
    } catch (e) {
      expect(e).toBeInstanceOf(HttpError);
      expect((e as HttpError).status).toBe(404);
      expect((e as HttpError).body).toEqual({ status: 'needs_setup' });
    }
  });

  it('handles 5xx without JSON body', async () => {
    fetchMock.mockResolvedValueOnce(new Response('server died', { status: 500 }));
    const client = new HttpClient('http://api.test', new StaticTokenProvider('t'));

    await expect(client.get('/x')).rejects.toMatchObject({
      status: 500,
      message: 'server died',
    });
  });

  it('returns null when body is empty', async () => {
    fetchMock.mockResolvedValueOnce(new Response('', { status: 204 }));
    const client = new HttpClient('http://api.test', new StaticTokenProvider('t'));
    const result = await client.get('/x');
    expect(result).toBeNull();
  });
});
