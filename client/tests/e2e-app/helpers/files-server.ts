// A fake boson-chat/files server for the upload specs, following the
// contract (docs: boson-files contract, "API"): /v1/config, /v1/me/usage,
// /v1/guest-token, POST /v1/files (raw body, X-Filename, Content-Length)
// and GET/HEAD /f/<id>/<name> (Cache-Control max-age = seconds left, 410
// once expired, Range). One per test, on a random loopback port; a dev /
// e2e build of the app reaches http on loopback. It doesn't check tokens,
// only records them.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

export interface FakeFilesOptions {
  enabled?: boolean;
  guestEnabled?: boolean;
  quota?: number;
  used?: number;
  maxFile?: number;
  retentionSeconds?: number;
  // Every upload is refused with this (e.g. quota_exceeded).
  refuse?: 'quota_exceeded' | 'file_too_large' | 'storage_full';
}

export interface StoredFile {
  id: string;
  name: string;
  type: string;
  body: Buffer;
  auth: string;
  createdAt: number;
  expired: boolean;
}

export interface FakeFiles {
  url: string;
  opts: Required<Omit<FakeFilesOptions, 'refuse'>> & Pick<FakeFilesOptions, 'refuse'>;
  files: StoredFile[];
  guestTokens: number;
  requests: Array<{ method: string; path: string; auth: string }>;
  expire(id: string): void;
  close(): Promise<void>;
}

const B62 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const fileId = (): string => Array.from(randomBytes(22), (b) => B62[b % 62]).join('');

const TYPES: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  mp4: 'video/mp4', webm: 'video/webm', mp3: 'audio/mpeg', ogg: 'audio/ogg', wav: 'audio/wav', txt: 'text/plain', pdf: 'application/pdf',
};

export async function startFakeFiles(o: FakeFilesOptions = {}): Promise<FakeFiles> {
  const opts = {
    enabled: o.enabled ?? true,
    guestEnabled: o.guestEnabled ?? true,
    quota: o.quota ?? 5e9,
    used: o.used ?? 1.2e9,
    maxFile: o.maxFile ?? 100e6,
    retentionSeconds: o.retentionSeconds ?? 2 * 86_400 + 600,
    refuse: o.refuse,
  };
  const state: FakeFiles = {
    url: '', opts, files: [], guestTokens: 0, requests: [],
    expire: (id) => { const f = state.files.find((x) => x.id === id); if (f) f.expired = true; },
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
  const json = (res: ServerResponse, status: number, body: unknown): void => {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Access-Control-Expose-Headers': 'Retry-After' });
    res.end(JSON.stringify(body));
  };
  // When the oldest uploads leave the window (fixed, as a real ledger's).
  const freesAtValue = new Date(Date.now() + 20 * 3_600_000 + 60_000).toISOString();
  const freesAt = (): string => freesAtValue;
  const usage = () => ({
    used: opts.used + state.files.reduce((s, f) => s + f.body.length, 0),
    quota: opts.quota,
    window_seconds: 259_200,
    max_file: opts.maxFile,
    frees: [{ bytes: 1e9, at: freesAt() }],
  });

  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    // The web build calls it cross-origin, like the real files host
    // (boson-chat/files: CORS *, bearer/guest tokens).
    if (req.method === 'OPTIONS' && req.headers['access-control-request-method']) {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, HEAD, POST, DELETE',
        'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-Filename, Range',
        'Access-Control-Max-Age': '600',
      });
      res.end();
      return;
    }
    const path = decodeURI((req.url ?? '/').split('?')[0]!);
    const auth = String(req.headers['authorization'] ?? '');
    state.requests.push({ method: req.method ?? '', path, auth });
    if (req.method === 'GET' && path === '/v1/config') {
      json(res, 200, {
        enabled: opts.enabled,
        guest_enabled: opts.guestEnabled,
        limits: {
          account: { quota_bytes: opts.quota, window_seconds: 259_200, max_file_bytes: opts.maxFile },
          guest: { quota_bytes: opts.quota, window_seconds: 259_200, max_file_bytes: opts.maxFile },
        },
        retention_seconds: opts.retentionSeconds,
      });
      return;
    }
    if (req.method === 'POST' && path === '/v1/guest-token') {
      if (!opts.guestEnabled) { json(res, 403, { error: 'guest_disabled' }); return; }
      state.guestTokens++;
      json(res, 200, { token: `guest-${state.guestTokens}-${randomBytes(6).toString('hex')}`, expires_at: new Date(Date.now() + 86_400_000).toISOString() });
      return;
    }
    if (req.method === 'GET' && path === '/v1/me/usage') {
      if (!auth) { json(res, 401, { error: 'unauthenticated' }); return; }
      json(res, 200, usage());
      return;
    }
    if (req.method === 'POST' && path === '/v1/files') {
      if (!/^(Bearer|Guest) \S+$/.test(auth)) { json(res, 401, { error: 'unauthenticated' }); return; }
      const length = Number(req.headers['content-length'] ?? NaN);
      if (!Number.isFinite(length)) { json(res, 411, { error: 'length_required' }); return; }
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const body = Buffer.concat(chunks);
        if (body.length !== length) { json(res, 400, { error: 'incomplete_body' }); return; }
        if (opts.refuse === 'quota_exceeded' || usage().used + length > opts.quota) {
          const u = usage();
          json(res, 413, { error: 'quota_exceeded', used: u.used, quota: u.quota, window_seconds: u.window_seconds, frees_at: freesAt() });
          return;
        }
        if (opts.refuse === 'file_too_large' || length > opts.maxFile) { json(res, 413, { error: 'file_too_large', max: opts.maxFile }); return; }
        if (opts.refuse === 'storage_full') { json(res, 507, { error: 'storage_full' }); return; }
        const name = decodeURIComponent(String(req.headers['x-filename'] ?? 'file'));
        const id = fileId();
        const type = String(req.headers['content-type'] ?? 'application/octet-stream');
        state.files.push({ id, name, type, body, auth, createdAt: Date.now(), expired: false });
        json(res, 201, {
          created_at: new Date().toISOString(),
          id, url: `${state.url}/f/${id}/${encodeURIComponent(name)}`, name, size: body.length, content_type: type,
          expires_at: new Date(Date.now() + opts.retentionSeconds * 1000).toISOString(),
        });
      });
      return;
    }
    const m = /^\/f\/([A-Za-z0-9]{22,})\/([^/]+)$/.exec(path);
    if (m && (req.method === 'GET' || req.method === 'HEAD')) {
      const f = state.files.find((x) => x.id === m[1]);
      if (!f) { res.writeHead(404, { 'Access-Control-Allow-Origin': '*' }); res.end(); return; }
      if (f.expired) { res.writeHead(410, { 'Content-Type': 'text/html', 'Access-Control-Allow-Origin': '*' }); res.end('<p>This file expired.</p>'); return; }
      const ext = f.name.split('.').pop()!.toLowerCase();
      const left = Math.max(0, Math.round(opts.retentionSeconds - (Date.now() - f.createdAt) / 1000));
      const expiresAt = new Date(f.createdAt + opts.retentionSeconds * 1000).toISOString();
      const headers: Record<string, string | number> = {
        // Non-inline types (svg, html, …) go out as an octet-stream attachment.
        'Content-Type': TYPES[ext] ?? 'application/octet-stream',
        'X-File-Content-Type': f.type,
        'X-File-Expires-At': expiresAt,
        'Access-Control-Allow-Origin': '*',
        'Cross-Origin-Resource-Policy': 'cross-origin',
        ETag: `"${f.id}"`,
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "sandbox; default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'",
        'Cache-Control': `public, max-age=${left}`,
        'Accept-Ranges': 'bytes',
        'Content-Disposition': TYPES[ext] ? 'inline' : 'attachment',
      };
      const range = /^bytes=(\d+)-(\d*)$/.exec(String(req.headers['range'] ?? ''));
      if (range) {
        const start = Number(range[1]);
        const end = range[2] ? Math.min(Number(range[2]), f.body.length - 1) : f.body.length - 1;
        res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${f.body.length}`, 'Content-Length': end - start + 1 });
        res.end(req.method === 'GET' ? f.body.subarray(start, end + 1) : undefined);
        return;
      }
      res.writeHead(200, { ...headers, 'Content-Length': f.body.length });
      res.end(req.method === 'GET' ? f.body : undefined);
      return;
    }
    json(res, 404, { error: 'not_found' });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  state.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return state;
}

// A dev-only boson.json (BOSON_NETWORK_JSON) for one IRC host naming its
// auth service and files host.
export function filesNetworkJson(irc: { host: string; port: number }, authUrl: string, filesUrl: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'boson-files-net-'));
  const file = join(dir, 'boson.json');
  writeFileSync(file, JSON.stringify({
    version: 1,
    irc: { host: irc.host, port: irc.port, tls: false },
    auth: { url: authUrl },
    files: { url: filesUrl },
  }));
  return file;
}
