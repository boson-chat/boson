export interface TokenProvider {
  getToken(): Promise<string | null>;
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
    const token = await this.tokenProvider.getToken();
    const headers: Record<string, string> = { 'Content-Type': contentType };
    if (token) headers['Authorization'] = `Bearer ${token}`;

    const res = await fetch(`${this.baseUrl}${path}`, { method: 'POST', headers, body: blob });
    const text = await res.text();
    const parsed = text ? safeJson(text) : null;
    if (!res.ok) {
      const msg = (parsed && typeof parsed === 'object' && 'error' in parsed)
        ? String((parsed as { error: unknown }).error)
        : text || res.statusText;
      throw new HttpError(res.status, msg, parsed);
    }
    return parsed as T;
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const token = await this.tokenProvider.getToken();
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = `Bearer ${token}`;

    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

    const text = await res.text();
    const parsed = text ? safeJson(text) : null;
    if (!res.ok) {
      const msg = (parsed && typeof parsed === 'object' && 'error' in parsed)
        ? String((parsed as { error: unknown }).error)
        : text || res.statusText;
      throw new HttpError(res.status, msg, parsed);
    }
    return parsed as T;
  }
}

function safeJson(s: string): unknown {
  try { return JSON.parse(s); } catch { return s; }
}
