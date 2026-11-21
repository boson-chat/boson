// window.bosonFiles (platform/wails.ts → desktop/files.go): the desktop
// shell finds each network's files host, holds the allowlist, makes the
// files host's small JSON calls and streams uploads and previews.
//
// An upload: beginUpload registers it (host, credentials, name, type,
// size) and returns a path on the app's own origin; the renderer POSTs the
// File there in ArrayBuffer chunks (?offset=<n>; files.service.ts
// sendChunks) and the shell streams them on to the files host as one
// request, emitting progress. Previews are served from filesViewUrl() (same origin, so the
// page's CSP needn't name any files host).

export interface FilesDiscovery {
  host: string;
  filesUrl?: string;
  source?: 'well-known' | 'auth' | 'home';
  error?: string;
}

export interface FilesCall {
  filesUrl: string;
  method: 'GET' | 'POST';
  path: '/v1/config' | '/v1/me/usage' | '/v1/guest-token';
  auth?: string;
}

export interface FilesCallResult {
  status: number;
  body?: string;
  error?: string;
}

export interface FilesUploadTicket {
  id?: string;
  path?: string;
  error?: string;
}

export interface FilesProgress {
  id: string;
  sent: number;
  total: number;
}

export interface FilesBridge {
  discover(host: string, refresh: boolean): Promise<FilesDiscovery>;
  // The files host of the app's own auth service (source "home").
  home?(refresh: boolean): Promise<FilesDiscovery>;
  request(call: FilesCall): Promise<FilesCallResult>;
  beginUpload(req: { filesUrl: string; auth?: string; name: string; type?: string; size: number }): Promise<FilesUploadTicket>;
  cancelUpload(id: string): Promise<void>;
  onProgress(fn: (p: FilesProgress) => void): () => void;
  // The web build: uploads the whole file to the files host itself (no
  // shell to stream through), resolving with the files host's answer.
  upload?(id: string, file: Blob, signal: AbortSignal): Promise<Response>;
  // The web build: where a file previews from (the files host itself).
  viewUrl?(url: string): string;
}

export function filesBridge(): FilesBridge | null {
  return (globalThis as { bosonFiles?: FilesBridge }).bosonFiles ?? null;
}

// Where the shell previews a file (desktop/files.go serveView).
export function filesViewUrl(url: string): string {
  const view = filesBridge()?.viewUrl;
  if (view) return view(url);
  return `/_boson/files/view?u=${encodeURIComponent(url)}`;
}
