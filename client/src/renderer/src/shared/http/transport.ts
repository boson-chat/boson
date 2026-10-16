// Network transport for the API client. In the desktop app the renderer runs
// on a Wails origin (wails://localhost), which our API (api.boson.chat) doesn't
// CORS-allow. Routing the request through the shell (Go's HTTP client in
// desktop/apiproxy.go, not subject to CORS) sidesteps that. The shell installs
// window.bosonApi; web builds / tests fall back to a direct fetch.

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

// Prefer the shell's API proxy when the desktop bridge is present.
export function defaultApiTransport(): ApiTransport {
  const bridge = typeof window !== 'undefined'
    ? (window as { bosonApi?: { fetch: ApiTransport } }).bosonApi
    : undefined;
  return bridge ? (req) => bridge.fetch(req) : fetchTransport;
}
