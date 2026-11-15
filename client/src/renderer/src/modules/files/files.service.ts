import { signal, type Signal } from '@preact/signals';
import { filesBridge, type FilesBridge } from './files-bridge';
import { parseFilesUrl, type FilesLink } from './files-url';
import { describeUploadError, type FilesUsage } from './quota';

// Uploads to the active server's network files host (boson-chat/files), and
// which hosts' links render inline.
//
// Which files host an upload goes to:
//   1. the network's own: per IRC host, discovery through the shell
//      (boson.json files.url, else its auth service's files_url;
//      desktop/files.go) and the host's public /v1/config — when it's
//      enabled and, for someone without an account on that network, guest
//      uploads are on;
//   2. else the home files host — the app's own auth service's files_url
//      (boson.chat's, or the configured default server's) — when the user is
//      signed in to that account in the app, as that account;
//   3. else none: no attach button.
// Links to every files host found, the home one included, render inline on
// any network.
//
// Credentials: the network account's access token ("Bearer"), else a guest
// token from /v1/guest-token, fetched on the first upload (or the first
// usage check, which opening the upload sheet does) and kept for its life.
// The home files host: the app account's token.
//
// Several files at once (uploadBatch): at most MAX_CONCURRENT_UPLOADS run,
// the rest wait ("queued"). Their links are posted in the order the files
// were listed, not the order they finish: a finished one waits for those
// before it; a failed or cancelled one is skipped.

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
  // The home files host (the network has none the user can use): uploads
  // count against the app account's quota there.
  home?: boolean;
  // Where they go, for the sheet: "boson.chat".
  label?: string;
}

export interface HomeFiles {
  filesUrl: string | null;
  config: FilesConfig | null;
}

export type UploadStatus = 'queued' | 'uploading' | 'done' | 'error';

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
  // The batch it was sent in (uploadBatch).
  batch: string;
}

export interface BatchItem {
  file: Blob;
  name: string;
}

export interface StartBatch {
  host: string;
  channel: string;
  items: readonly BatchItem[];
  // One caption for the batch (a single file: "<caption> <url>").
  caption?: string;
  // Posts a message to the channel (the chat's own send, which the engine
  // paces).
  post: (text: string) => void;
  // The most bytes one message's text may have (ircTextBudget); default
  // DEFAULT_TEXT_BYTES.
  maxTextBytes?: number;
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
  // Upload chunk size (tests).
  chunkBytes?: number;
  // Whether the user is signed in to the app's own account (not a guest).
  homeSignedIn?: () => boolean;
  // That account's access token (null: none).
  homeToken?: () => Promise<string | null>;
}

interface Running {
  abort: AbortController;
  ticket?: string;
}

interface Job {
  file: Blob;
  batch: Batch;
}

interface Batch {
  id: string;
  ids: string[];
  caption: string;
  post: (text: string) => void;
  maxTextBytes: number;
  // Posting the URLs together in one message is possible (by the files'
  // names): wait for all, then check. Otherwise each is posted as soon as
  // those before it are settled.
  together: boolean;
  // url, or null: failed / cancelled (skipped). Absent: not settled yet.
  results: Map<string, string | null>;
  next: number;
  captionPosted: boolean;
  closed: boolean;
}

// At most this many uploads run at once; the rest are queued.
export const MAX_CONCURRENT_UPLOADS = 2;
// At most this many files in one batch.
export const MAX_BATCH_FILES = 20;
// A message's text when the line's other parts aren't known: 512 bytes less
// a long prefix (":nick!user@host PRIVMSG #channel :" and CRLF).
export const DEFAULT_TEXT_BYTES = 350;

// The bytes left for a PRIVMSG's text from nick to target in a 512-byte IRC
// line: ":<nick>!<user>@<host> PRIVMSG <target> :<text>\r\n", allowing a
// 10-byte user and a 63-byte host (the server's longest; others see the
// line with this prefix).
export function ircTextBudget(nick: string, target: string, lineBytes = 512): number {
  const prefix = 1 + byteLength(nick) + 1 + 10 + 1 + 63;
  return Math.max(0, lineBytes - prefix - ' PRIVMSG '.length - byteLength(target) - 2 - 2);
}

function byteLength(s: string): number {
  return new TextEncoder().encode(s).length;
}

// How a files host is named to the user: its host without "files." —
// "https://files.boson.chat" → "boson.chat".
export function filesHostLabel(filesUrl: string): string {
  try {
    return new URL(filesUrl).hostname.replace(/^files\./, '');
  } catch {
    return filesUrl;
  }
}

const GUEST_TOKEN_DEFAULT_MS = 23 * 3_600_000;

const hostKey = (h: string): string => h.trim().toLowerCase();

function parseJson<T>(body: string | undefined): T | null {
  if (!body) return null;
  try { return JSON.parse(body) as T; } catch { return null; }
}

// Uploads go to the shell in chunks of this many bytes, each an
// ArrayBuffer body. Not the File itself: WKWebView (macOS) passes a Blob or
// File request body to the app's custom-scheme handler as no body at all,
// while an ArrayBuffer arrives whole on every webview. A chunk at a time
// keeps a large file out of memory (desktop/files.go serveUpload).
export const UPLOAD_CHUNK_BYTES = 4 * 1024 * 1024;

// The shell's answer to a chunk that wasn't the last.
const MORE_HEADER = 'X-Boson-Upload';

// sendChunks POSTs file to path in order, ?offset=<n> on each, one at a
// time. Returns the shell's answer to the last chunk, or to the first one
// it didn't answer "more" to (a refusal part-way).
export async function sendChunks(
  doFetch: typeof fetch, path: string, file: Blob, chunkBytes: number, signal: AbortSignal,
): Promise<Response> {
  const size = file.size;
  const step = Math.max(1, Math.floor(chunkBytes));
  for (let offset = 0; ; ) {
    const end = Math.min(offset + step, size);
    const chunk = await file.slice(offset, end).arrayBuffer();
    if (signal.aborted) throw new DOMException('aborted', 'AbortError');
    const sep = path.includes('?') ? '&' : '?';
    const res = await doFetch(`${path}${sep}offset=${offset}`, {
      method: 'POST',
      body: chunk,
      headers: { 'Content-Type': 'application/octet-stream' },
      signal,
    });
    if (res.headers.get(MORE_HEADER) !== 'more' || end >= size) return res;
    await res.text().catch(() => '');
    offset = end;
  }
}

// The message posted for a finished upload: "<caption> <url>", or the URL.
export function uploadMessage(url: string, caption = ''): string {
  const c = caption.replace(/\s+/g, ' ').trim();
  return c ? `${c} ${url}` : url;
}

export class FilesController {
  readonly hosts: Signal<Readonly<Record<string, HostFiles>>> = signal({});
  // The app account's files host (null: not looked up yet).
  readonly home: Signal<HomeFiles | null> = signal(null);
  // Origins of every files host found (their links render inline).
  readonly origins: Signal<ReadonlySet<string>> = signal(new Set());
  readonly uploads: Signal<readonly Upload[]> = signal([]);
  private readonly deps: FilesControllerDeps;
  private readonly loading = new Map<string, Promise<void>>();
  private homeLoading: Promise<void> | null = null;
  private readonly guestTokens = new Map<string, { token: string; until: number }>();
  private readonly guestFetches = new Map<string, Promise<string | null>>();
  private readonly running = new Map<string, Running>();
  private readonly byTicket = new Map<string, string>();
  private readonly jobs = new Map<string, Job>();
  private readonly queue: string[] = [];
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
    this.queue.length = 0;
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
    void this.ensureHome(refresh);
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
        config = await this.fetchConfig(bridge, filesUrl);
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

  // The home files host (deduped; refresh: again). Older shells without
  // it: none.
  ensureHome(refresh = false): Promise<void> {
    const bridge = this.bridge();
    if (!bridge?.home) return Promise.resolve();
    if (!refresh && this.home.value) return Promise.resolve();
    if (this.homeLoading) return this.homeLoading;
    const home = bridge.home.bind(bridge);
    const p = (async () => {
      let filesUrl: string | null = null;
      let config: FilesConfig | null = null;
      try {
        filesUrl = (await home(refresh)).filesUrl || null;
      } catch { filesUrl = null; }
      if (filesUrl) {
        this.addOrigin(filesUrl);
        config = await this.fetchConfig(bridge, filesUrl);
      }
      this.home.value = { filesUrl, config };
    })().finally(() => { this.homeLoading = null; });
    this.homeLoading = p;
    return p;
  }

  private async fetchConfig(bridge: FilesBridge, filesUrl: string): Promise<FilesConfig | null> {
    try {
      const r = await bridge.request({ filesUrl, method: 'GET', path: '/v1/config' });
      const c = r.status === 200 ? parseJson<Partial<FilesConfig> & { accounts_enabled?: boolean }>(r.body) : null;
      return c ? { ...c, enabled: c.enabled !== false, guest_enabled: c.guest_enabled !== false } : null;
    } catch {
      return null;
    }
  }

  isFilesOrigin = (origin: string): boolean => this.origins.value.has(origin.toLowerCase());

  parse(url: string): FilesLink | null {
    return parseFilesUrl(url, this.isFilesOrigin);
  }

  // Where host's uploads go: the network's files host when the user can
  // use it, else the home one when signed in to the app's account.
  private target(host: string): { filesUrl: string; home: boolean; guest: boolean; limits: FilesLimits | null } | null {
    const h = this.hosts.value[host];
    const guest = !this.deps.signedIn?.(host);
    if (h?.filesUrl && h.config?.enabled && (!guest || h.config.guest_enabled)) {
      return { filesUrl: h.filesUrl, home: false, guest, limits: (guest ? h.config.limits?.guest : h.config.limits?.account) ?? null };
    }
    const home = this.home.value;
    if (home?.filesUrl && home.config?.enabled && this.deps.homeSignedIn?.()) {
      return { filesUrl: home.filesUrl, home: true, guest: false, limits: home.config.limits?.account ?? null };
    }
    return null;
  }

  availability(rawHost: string | null | undefined): FilesAvailability {
    const none: FilesAvailability = { available: false, filesUrl: null, guest: true, limits: null };
    if (!rawHost) return none;
    const t = this.target(hostKey(rawHost));
    if (!t) return none;
    return {
      available: true, filesUrl: t.filesUrl, guest: t.guest, limits: t.limits,
      ...(t.home ? { home: true, label: filesHostLabel(t.filesUrl) } : {}),
    };
  }

  // ---- credentials ----

  private async credentials(host: string, filesUrl: string, home: boolean, renewGuest = false): Promise<string> {
    if (home) {
      const token = await this.deps.homeToken?.().catch(() => null);
      return token ? `Bearer ${token}` : '';
    }
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
    const t = this.target(host);
    const bridge = this.bridge();
    if (!t || !bridge) return null;
    try {
      const auth = await this.credentials(host, t.filesUrl, t.home);
      const r = await bridge.request({ filesUrl: t.filesUrl, method: 'GET', path: '/v1/me/usage', ...(auth ? { auth } : {}) });
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

  // Starts one upload; returns its id. Finished, it posts its message.
  upload(req: StartUpload): string {
    return this.uploadBatch({
      host: req.host, channel: req.channel, items: [{ file: req.file, name: req.name }], caption: req.caption, post: req.post,
    })[0]!;
  }

  // Queues several files (at most MAX_BATCH_FILES); returns their ids. Their
  // links are posted in this order (see Batch).
  uploadBatch(req: StartBatch): string[] {
    const host = hostKey(req.host);
    const items = req.items.slice(0, MAX_BATCH_FILES);
    if (items.length === 0) return [];
    const caption = req.caption?.replace(/\s+/g, ' ').trim() ?? '';
    const maxTextBytes = req.maxTextBytes ?? DEFAULT_TEXT_BYTES;
    const filesUrl = this.target(host)?.filesUrl ?? '';
    const guess = items.map((it) => `${filesUrl}/f/${'x'.repeat(22)}/${encodeURIComponent(it.name)}`).join(' ');
    const batch: Batch = {
      id: `b${++this.seq}`, ids: [], caption, post: req.post, maxTextBytes,
      together: items.length > 1 && byteLength(guess) <= maxTextBytes,
      results: new Map(), next: 0, captionPosted: false, closed: false,
    };
    const rows: Upload[] = [];
    for (const it of items) {
      const id = `u${++this.seq}`;
      batch.ids.push(id);
      this.jobs.set(id, { file: it.file, batch });
      this.queue.push(id);
      rows.push({
        id, host, channel: req.channel, name: it.name, size: it.file.size, caption: items.length === 1 ? caption : '',
        sent: 0, status: 'queued', batch: batch.id,
      });
    }
    this.uploads.value = [...this.uploads.value, ...rows];
    this.pump();
    return [...batch.ids];
  }

  // Starts queued uploads while fewer than MAX_CONCURRENT_UPLOADS run.
  private pump(): void {
    while (this.running.size < MAX_CONCURRENT_UPLOADS && this.queue.length > 0) {
      const id = this.queue.shift()!;
      const job = this.jobs.get(id);
      const row = this.uploads.value.find((u) => u.id === id);
      if (!job || !row) continue;
      const run: Running = { abort: new AbortController() };
      this.running.set(id, run);
      this.patch(id, { status: 'uploading' });
      void this.run(id, row.host, row.name, job.file, run)
        .catch(() => null)
        .then((url) => {
          this.running.delete(id);
          if (run.ticket) this.byTicket.delete(run.ticket);
          if (!run.abort.signal.aborted) this.settle(id, url ?? null);
          this.pump();
        });
    }
  }

  // Records id's outcome and posts what's now in order.
  private settle(id: string, url: string | null): void {
    const job = this.jobs.get(id);
    if (!job) return;
    this.jobs.delete(id);
    job.batch.results.set(id, url);
    this.flush(job.batch);
  }

  private flush(b: Batch): void {
    if (b.closed) return;
    if (b.ids.length === 1) {
      const url = b.results.get(b.ids[0]!);
      if (url === undefined) return;
      b.closed = true;
      if (url) b.post(uploadMessage(url, b.caption));
      return;
    }
    if (b.together) {
      if (b.results.size < b.ids.length) return;
      b.closed = true;
      const urls = b.ids.map((id) => b.results.get(id)).filter((u): u is string => !!u);
      if (urls.length === 0) return;
      if (b.caption) b.post(b.caption);
      const line = urls.join(' ');
      if (byteLength(line) <= b.maxTextBytes) b.post(line);
      else urls.forEach((u) => b.post(u));
      return;
    }
    while (b.next < b.ids.length) {
      const url = b.results.get(b.ids[b.next]!);
      if (url === undefined) return;
      b.next++;
      if (!url) continue;
      if (b.caption && !b.captionPosted) {
        b.captionPosted = true;
        b.post(b.caption);
      }
      b.post(url);
    }
    b.closed = true;
  }

  // Uploads one file; its link, or null (failed: the row says why).
  private async run(id: string, host: string, name: string, blob: Blob, run: Running): Promise<string | null> {
    const bridge = this.bridge();
    const t = this.target(host);
    const file = { name, size: blob.size };
    const fail = async (status: number, body: string, retryAfter?: string | null): Promise<null> => {
      if (run.abort.signal.aborted) return null;
      let frees: FilesUsage['frees'];
      if (/quota_exceeded/.test(body)) frees = (await this.usage(host))?.frees;
      const e = describeUploadError(status, body, { now: this.now(), frees, file, retryAfter });
      this.patch(id, { status: 'error', error: e.message, errorCode: e.code });
      return null;
    };
    if (!bridge || !t) return fail(0, '');
    const { filesUrl, home } = t;
    const doFetch = this.deps.fetch ?? fetch.bind(globalThis);
    for (let attempt = 0; attempt < 2; attempt++) {
      let auth: string;
      try { auth = await this.credentials(host, filesUrl, home, attempt > 0); } catch { auth = ''; }
      if (run.abort.signal.aborted) return null;
      const ticket = await bridge.beginUpload({
        filesUrl, name, size: blob.size, ...(auth ? { auth } : {}), ...(blob.type ? { type: blob.type } : {}),
      }).catch((err: unknown) => ({ error: String(err) } as { id?: string; path?: string; error?: string }));
      if (!ticket.id || !ticket.path) return fail(0, JSON.stringify({ error: 'upload_failed', message: ticket.error ?? '' }));
      run.ticket = ticket.id;
      this.byTicket.set(ticket.id, id);
      if (run.abort.signal.aborted) { void bridge.cancelUpload(ticket.id); return null; }
      let status = 0;
      let body = '';
      let retryAfter: string | null = null;
      try {
        const res = await sendChunks(doFetch, ticket.path, blob, this.deps.chunkBytes ?? UPLOAD_CHUNK_BYTES, run.abort.signal);
        status = res.status;
        retryAfter = res.headers.get('Retry-After');
        body = await res.text();
      } catch {
        if (run.abort.signal.aborted) return null;
        return fail(0, '');
      }
      // A guest token that lapsed or was refused (invalid_guest_token): one
      // more go with a fresh one.
      if (status === 401 && attempt === 0 && auth.startsWith('Guest ')) continue;
      if (status >= 200 && status < 300) {
        const j = parseJson<{ url?: string }>(body);
        if (!j?.url) return fail(status, body);
        this.patch(id, { status: 'done', sent: blob.size, url: j.url });
        this.addOrigin(filesUrl);
        setTimeout(() => this.remove(id), this.deps.doneLingerMs ?? 1500);
        return j.url;
      }
      return fail(status, body, retryAfter);
    }
    return null;
  }

  // Cancels one upload, running or queued; the rest of its batch goes on.
  cancel(id: string): void {
    const q = this.queue.indexOf(id);
    if (q >= 0) this.queue.splice(q, 1);
    const run = this.running.get(id);
    if (run) {
      run.abort.abort();
      if (run.ticket) void this.bridge()?.cancelUpload(run.ticket).catch(() => {});
    }
    this.remove(id);
    this.settle(id, null);
  }

  // Cancels every upload not finished yet in host's channel.
  cancelAll(rawHost: string, channel: string): void {
    for (const u of this.uploadsFor(rawHost, channel)) {
      if (u.status === 'queued' || u.status === 'uploading') this.cancel(u.id);
    }
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
