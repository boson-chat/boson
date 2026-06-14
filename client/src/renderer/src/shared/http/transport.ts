// Network transport for the API client. In Electron the renderer runs on a
// loopback http origin (so origin/referrer-sensitive embeds work), but our API
// (api.boson.chat) only CORS-allows the legacy file:// null origin. Routing the
// request through the main process (Node fetch, not subject to CORS) sidesteps
// that. The preload exposes window.bosonApi; web builds / tests fall back to a
// direct fetch.

export interface ApiRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: string | ArrayBuffer | null;
}

export interface ApiResponse {
  status: number;
  ok: boolean;
  statusText: string;
  text: string;
}

export type ApiTransport = (req: ApiRequest) => Promise<ApiResponse>;

// Direct fetch — used on the web build and in tests (which mock globalThis.fetch).
export const fetchTransport: ApiTransport = async ({ method, url, headers, body }) => {
  const res = await fetch(url, { method, headers, body: body ?? undefined });
  const text = await res.text();
  return { status: res.status, ok: res.ok, statusText: res.statusText, text };
};

// Prefer the main-process proxy when the Electron bridge is present.
export function defaultApiTransport(): ApiTransport {
  const bridge = typeof window !== 'undefined'
    ? (window as { bosonApi?: { fetch: ApiTransport } }).bosonApi
    : undefined;
  return bridge ? (req) => bridge.fetch(req) : fetchTransport;
}
