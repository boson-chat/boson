import { type ApiTransport, defaultApiTransport } from './transport';

export interface TokenProvider {
  getToken(): Promise<string | null>;
  // Called when the API answers 401 to `token`: return a fresh token to
  // retry once with (AuthService refreshes, single-flight), or null.
  tokenRejected?(token: string): Promise<string | null>;
}

export class HttpError extends Error {
  constructor(public readonly status: number, message: string, public readonly body?: unknown) {
    super(message);
  }
}

export class HttpClient {
  constructor(
    private readonly baseUrl: string,
    private readonly tokenProvider: TokenProvider,
    // Network transport — defaults to the desktop shell's API proxy when
    // available, else a direct fetch. Injectable for tests.
    private readonly transport: ApiTransport = defaultApiTransport(),
  ) {}

  async get<T>(path: string): Promise<T> {
    return this.request<T>('GET', path);
  }

  async post<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>('POST', path, body);
  }

  async put<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>('PUT', path, body);
  }

  async patch<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>('PATCH', path, body);
  }

  async delete<T = void>(path: string): Promise<T> {
    return this.request<T>('DELETE', path);
  }

  // Upload raw bytes (e.g. an image) with an explicit content type. Unlike
  // request(), the body is sent verbatim, not JSON-encoded. The response is
  // still parsed as JSON.
  async postBlob<T>(path: string, blob: Blob, contentType: string): Promise<T> {
    // Send raw bytes; the transport (IPC proxy or fetch) carries the buffer.
    const bytes = await blob.arrayBuffer();
    return this.send<T>('POST', path, contentType, bytes);
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    return this.send<T>(method, path, 'application/json', body !== undefined ? JSON.stringify(body) : null);
  }

  // One request, retried once with a refreshed token if the API says 401
  // (the access token expired or the signing key rotated under us).
  private async send<T>(method: string, path: string, contentType: string, body: string | ArrayBuffer | null): Promise<T> {
    const attempt = (token: string | null) => {
      const headers: Record<string, string> = { 'Content-Type': contentType };
      if (token) headers['Authorization'] = `Bearer ${token}`;
      return this.transport({ method, url: `${this.baseUrl}${path}`, headers, body });
    };
    const token = await this.tokenProvider.getToken();
    let res = await attempt(token);
    if (res.status === 401 && token && this.tokenProvider.tokenRejected) {
      const fresh = await this.tokenProvider.tokenRejected(token);
      if (fresh && fresh !== token) res = await attempt(fresh);
    }
    return this.parse<T>(res);
  }

  private parse<T>(res: { ok: boolean; status: number; statusText: string; text: string }): T {
    const parsed = res.text ? safeJson(res.text) : null;
    if (!res.ok) {
      const msg = (parsed && typeof parsed === 'object' && 'error' in parsed)
        ? String((parsed as { error: unknown }).error)
        : res.text || res.statusText;
      throw new HttpError(res.status, msg, parsed);
    }
    return parsed as T;
  }
}

function safeJson(s: string): unknown {
  try { return JSON.parse(s); } catch { return s; }
}
