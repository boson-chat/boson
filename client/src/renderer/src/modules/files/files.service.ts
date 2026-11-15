import { signal, type Signal } from '@preact/signals';
import { filesBridge, type FilesBridge } from './files-bridge';
import { parseFilesUrl, type FilesLink } from './files-url';
import { describeUploadError, type FilesUsage } from './quota';

// Uploads to the active server's network files host (boson-chat/files), and
// which hosts' links render inline.
//
// Per IRC host: discovery through the shell (boson.json files.url, else
// its auth service's files_url; desktop/files.go) and the host's public
// /v1/config. The attach button shows only when the network has a files
// host, it's enabled, and — for someone without an account on that
// network — guest uploads are on.
//
// Credentials: the network account's access token ("Bearer"), else a guest
// token from /v1/guest-token, fetched on the first upload (or the first
// usage check, which opening the upload sheet does) and kept for its life.

export interface FilesLimits {
  quota_bytes?: number;
  window_seconds?: number;
  max_file_bytes?: number;
}

export interface FilesConfig {
  enabled: boolean;
  guest_enabled: boolean;
  limits?: { account?: FilesLimits; guest?: FilesLimits };
  retention_seconds?: number;
}

export interface HostFiles {
  host: string;
  filesUrl: string | null;
  config: FilesConfig | null;
}

export interface FilesAvailability {
  available: boolean;
  filesUrl: string | null;
  guest: boolean;
  limits: FilesLimits | null;
}

export type UploadStatus = 'uploading' | 'done' | 'error';

export interface Upload {
  id: string;
  host: string;
  channel: string;
  name: string;
  size: number;
  caption: string;
  sent: number;
  status: UploadStatus;
  error?: string;
  errorCode?: string;
  url?: string;
}

export interface StartUpload {
  host: string;
  channel: string;
  file: Blob;
  name: string;
  caption?: string;
  // Posts the finished message to the channel.
  post: (text: string) => void;
}

export interface FilesControllerDeps {
  bridge?: FilesBridge | null;
  // Whether the user has an account session on host's network.
  signedIn?: (host: string) => boolean;
  // That session's access token (null: none).
  accountToken?: (host: string) => Promise<string | null>;
  fetch?: typeof fetch;
  now?: () => number;
  // How long a finished upload's row stays.
  doneLingerMs?: number;
}

interface Running {
  abort: AbortController;
  ticket?: string;
}

const GUEST_TOKEN_DEFAULT_MS = 23 * 3_600_000;

const hostKey = (h: string): string => h.trim().toLowerCase();

function parseJson<T>(body: string | undefined): T | null {
  if (!body) return null;
  try { return JSON.parse(body) as T; } catch { return null; }
}

// The message posted for a finished upload: "<caption> <url>", or the URL.
export function uploadMessage(url: string, caption = ''): string {
  const c = caption.replace(/\s+/g, ' ').trim();
  return c ? `${c} ${url}` : url;
}

export class FilesController {
  readonly hosts: Signal<Readonly<Record<string, HostFiles>>> = signal({});
  // Origins of every files host found (their links render inline).
  readonly origins: Signal<ReadonlySet<string>> = signal(new Set());
  readonly uploads: Signal<readonly Upload[]> = signal([]);
  private readonly deps: FilesControllerDeps;
  private readonly loading = new Map<string, Promise<void>>();
  private readonly guestTokens = new Map<string, { token: string; until: number }>();
  private readonly guestFetches = new Map<string, Promise<string | null>>();
  private readonly running = new Map<string, Running>();
  private readonly byTicket = new Map<string, string>();
  private seq = 0;
  private offProgress: (() => void) | null = null;

  constructor(deps: FilesControllerDeps = {}) {
    this.deps = deps;
    this.offProgress = this.bridge()?.onProgress((p) => {
      const id = this.byTicket.get(p.id);
      if (id) this.patch(id, { sent: Math.min(p.sent, p.total) });
    }) ?? null;
  }

  dispose(): void {
    this.offProgress?.();
    for (const r of this.running.values()) r.abort.abort();
  }

  private bridge(): FilesBridge | null {
    return this.deps.bridge === undefined ? filesBridge() : this.deps.bridge;
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  // ---- discovery ----

  // Looks host's files host and config up (deduped; refresh: again).
  ensure(rawHost: string, refresh = false): Promise<void> {
    const host = hostKey(rawHost);
    const bridge = this.bridge();
    if (!host || !bridge) return Promise.resolve();
    if (!refresh && host in this.hosts.value) return Promise.resolve();
    const running = this.loading.get(host);
    if (running) return running;
    const p = (async () => {
      let filesUrl: string | null = null;
      let config: FilesConfig | null = null;
      try {
        const d = await bridge.discover(host, refresh);
        filesUrl = d.filesUrl || null;
      } catch { filesUrl = null; }
      if (filesUrl) {
        this.addOrigin(filesUrl);
        try {
          const r = await bridge.request({ filesUrl, method: 'GET', path: '/v1/config' });
          const c = r.status === 200 ? parseJson<Partial<FilesConfig>>(r.body) : null;
          if (c) config = { ...c, enabled: c.enabled !== false, guest_enabled: c.guest_enabled !== false };
        } catch { config = null; }
      }
      this.hosts.value = { ...this.hosts.value, [host]: { host, filesUrl, config } };
    })().finally(() => this.loading.delete(host));
    this.loading.set(host, p);
    return p;
  }

  private addOrigin(filesUrl: string): void {
    try {
      const o = new URL(filesUrl).origin.toLowerCase();
      if (this.origins.value.has(o)) return;
      this.origins.value = new Set([...this.origins.value, o]);
    } catch { /* not a URL */ }
  }

  isFilesOrigin = (origin: string): boolean => this.origins.value.has(origin.toLowerCase());

  parse(url: string): FilesLink | null {
    return parseFilesUrl(url, this.isFilesOrigin);
  }

  availability(rawHost: string | null | undefined): FilesAvailability {
    const none: FilesAvailability = { available: false, filesUrl: null, guest: true, limits: null };
    if (!rawHost) return none;
    const h = this.hosts.value[hostKey(rawHost)];
    if (!h?.filesUrl || !h.config) return none;
    const guest = !this.deps.signedIn?.(hostKey(rawHost));
    const available = h.config.enabled && (!guest || h.config.guest_enabled);
    return { available, filesUrl: h.filesUrl, guest, limits: (guest ? h.config.limits?.guest : h.config.limits?.account) ?? null };
  }

  // ---- credentials ----

  private async credentials(host: string, filesUrl: string, renewGuest = false): Promise<string> {
    if (this.deps.signedIn?.(host)) {
      const token = await this.deps.accountToken?.(host).catch(() => null);
      if (token) return `Bearer ${token}`;
    }
    const g = await this.guestToken(filesUrl, renewGuest);
    return g ? `Guest ${g}` : '';
  }

  private guestToken(filesUrl: string, renew: boolean): Promise<string | null> {
    const hit = this.guestTokens.get(filesUrl);
    if (hit && !renew && hit.until > this.now()) return Promise.resolve(hit.token);
    const running = this.guestFetches.get(filesUrl);
    if (running) return running;
    const p = (async () => {
      const r = await this.bridge()?.request({ filesUrl, method: 'POST', path: '/v1/guest-token' }).catch(() => null);
      const j = r && r.status >= 200 && r.status < 300 ? parseJson<{ token?: string; expires_at?: string; expires_in?: number }>(r.body) : null;
      if (!j?.token) return null;
      const at = j.expires_at ? Date.parse(j.expires_at) : NaN;
      const until = !Number.isNaN(at) ? at - 60_000 : this.now() + (j.expires_in ? j.expires_in * 1000 - 60_000 : GUEST_TOKEN_DEFAULT_MS);
      this.guestTokens.set(filesUrl, { token: j.token, until });
      return j.token;
    })().finally(() => this.guestFetches.delete(filesUrl));
    this.guestFetches.set(filesUrl, p);
    return p;
  }

  // ---- usage ----

  async usage(rawHost: string): Promise<FilesUsage | null> {
    const host = hostKey(rawHost);
    const filesUrl = this.hosts.value[host]?.filesUrl;
    const bridge = this.bridge();
    if (!filesUrl || !bridge) return null;
    try {
      const auth = await this.credentials(host, filesUrl);
      const r = await bridge.request({ filesUrl, method: 'GET', path: '/v1/me/usage', ...(auth ? { auth } : {}) });
      return r.status === 200 ? parseJson<FilesUsage>(r.body) : null;
    } catch {
      return null;
    }
  }

  // ---- uploads ----

  private patch(id: string, p: Partial<Upload>): void {
    this.uploads.value = this.uploads.value.map((u) => (u.id === id ? { ...u, ...p } : u));
  }

  private remove(id: string): void {
    this.uploads.value = this.uploads.value.filter((u) => u.id !== id);
  }

  uploadsFor(rawHost: string, channel: string): Upload[] {
    const host = hostKey(rawHost);
    const ch = channel.toLowerCase();
    return this.uploads.value.filter((u) => u.host === host && u.channel.toLowerCase() === ch);
  }

  // Starts an upload; returns its id. Finished, it posts its message.
  upload(req: StartUpload): string {
    const host = hostKey(req.host);
    const id = `u${++this.seq}`;
    const caption = req.caption?.trim() ?? '';
    this.uploads.value = [...this.uploads.value, {
      id, host, channel: req.channel, name: req.name, size: req.file.size, caption, sent: 0, status: 'uploading',
    }];
    const run: Running = { abort: new AbortController() };
    this.running.set(id, run);
    void this.run(id, host, req, run).finally(() => {
      this.running.delete(id);
      if (run.ticket) this.byTicket.delete(run.ticket);
    });
    return id;
  }

  private async run(id: string, host: string, req: StartUpload, run: Running): Promise<void> {
    const bridge = this.bridge();
    const filesUrl = this.hosts.value[host]?.filesUrl;
    const file = { name: req.name, size: req.file.size };
    const fail = async (status: number, body: string): Promise<void> => {
      if (run.abort.signal.aborted) return;
      let frees: FilesUsage['frees'];
      if (/quota_exceeded/.test(body)) frees = (await this.usage(host))?.frees;
      const e = describeUploadError(status, body, { now: this.now(), frees, file });
      this.patch(id, { status: 'error', error: e.message, errorCode: e.code });
    };
    if (!bridge || !filesUrl) return fail(0, '');
    const doFetch = this.deps.fetch ?? fetch.bind(globalThis);
    for (let attempt = 0; attempt < 2; attempt++) {
      let auth: string;
      try { auth = await this.credentials(host, filesUrl, attempt > 0); } catch { auth = ''; }
      if (run.abort.signal.aborted) return;
      const ticket = await bridge.beginUpload({
        filesUrl, name: req.name, size: req.file.size, ...(auth ? { auth } : {}), ...(req.file.type ? { type: req.file.type } : {}),
      }).catch((err: unknown) => ({ error: String(err) } as { id?: string; path?: string; error?: string }));
      if (!ticket.id || !ticket.path) return fail(0, JSON.stringify({ error: 'upload_failed', message: ticket.error ?? '' }));
      run.ticket = ticket.id;
      this.byTicket.set(ticket.id, id);
      if (run.abort.signal.aborted) { void bridge.cancelUpload(ticket.id); return; }
      let status = 0;
      let body = '';
      try {
        const res = await doFetch(ticket.path, {
          method: 'POST',
          body: req.file,
          headers: { 'Content-Type': 'application/octet-stream' },
          signal: run.abort.signal,
        });
        status = res.status;
        body = await res.text();
      } catch {
        if (run.abort.signal.aborted) return;
        return fail(0, '');
      }
      // A guest token that lapsed: one more go with a fresh one.
      if (status === 401 && attempt === 0 && auth.startsWith('Guest ')) continue;
      if (status >= 200 && status < 300) {
        const j = parseJson<{ url?: string }>(body);
        if (!j?.url) return fail(status, body);
        this.patch(id, { status: 'done', sent: req.file.size, url: j.url });
        this.addOrigin(filesUrl);
        req.post(uploadMessage(j.url, req.caption));
        setTimeout(() => this.remove(id), this.deps.doneLingerMs ?? 1500);
        return;
      }
      return fail(status, body);
    }
  }

  cancel(id: string): void {
    const run = this.running.get(id);
    if (run) {
      run.abort.abort();
      if (run.ticket) void this.bridge()?.cancelUpload(run.ticket).catch(() => {});
    }
    this.remove(id);
  }

  dismiss(id: string): void {
    this.remove(id);
  }
}

let instance: FilesController | null = null;

export function getFiles(): FilesController | null {
  return instance;
}

export function setFiles(c: FilesController | null): void {
  instance?.dispose();
  instance = c;
}
