// window.bosonFiles on the web (desktop/files.go): each network's files
// host (boson.json files.url, else its auth service's /v1/config
// files_url), the files API's small JSON calls, and uploads. The desktop
// streams uploads through the shell; here the browser POSTs the file
// straight to the files host (whose CORS allows any origin, with bearer or
// guest tokens — never cookies), with upload progress from XHR. Previews
// load from the files host directly too.
import { cleanBaseUrl, type NetworkDiscoverer } from './discovery';

const CALLS = new Set(['GET /v1/config', 'GET /v1/me/usage', 'POST /v1/guest-token']);
const TTL_MS = 5 * 60_000;

interface Pending { base: string; auth: string; name: string; type: string; size: number; xhr?: XMLHttpRequest }

function originOf(u: string): string {
  try { return new URL(u).origin; } catch { return ''; }
}

function cleanAuth(auth: string | undefined): string | null {
  if (!auth) return '';
  const m = /^(Bearer|Guest) ([^\s]{1,8192})$/.exec(auth);
  return m ? auth : null;
}

function cleanName(name: string): string {
  const n = name.replace(/[\u0000-\u001f\u007f/\\]/g, '_').trim().slice(0, 255);
  return n || 'file';
}

export function webFilesBridge(deps: { discoverer: NetworkDiscoverer; mainAuthUrl: string; appOrigins: string[] }) {
  const allowHttp = deps.discoverer.allowLoopbackHttp;
  const hosts = new Set<string>();
  const authCfg = new Map<string, { at: number; url: string }>();
  const pending = new Map<string, Pending>();
  const progress = new Set<(p: { id: string; sent: number; total: number }) => void>();
  const emit = (id: string, sent: number, total: number): void => { for (const fn of progress) fn({ id, sent, total }); };

  const trust = (raw: string): string | { error: string } => {
    const base = cleanBaseUrl(raw, allowHttp);
    if (!base) return { error: `${raw} is not an https base URL` };
    const o = originOf(base);
    if (deps.appOrigins.includes(o) || o === originOf(deps.mainAuthUrl)) return { error: 'files host shares an origin with an app service' };
    hosts.add(o);
    return base;
  };

  const trustedBase = (raw: string): string | null => {
    const base = cleanBaseUrl(raw, allowHttp);
    return base && hosts.has(originOf(base)) ? base : null;
  };

  const authFilesUrl = async (auth: string, refresh: boolean): Promise<string> => {
    const base = cleanBaseUrl(auth, allowHttp);
    if (!base) return '';
    const hit = authCfg.get(base);
    if (hit && !refresh && Date.now() - hit.at < TTL_MS) return hit.url;
    try {
      const res = await fetch(`${base}/v1/config`, { headers: { Accept: 'application/json' }, credentials: 'omit' });
      const cfg = res.ok ? (await res.json() as { files_url?: string }) : {};
      authCfg.set(base, { at: Date.now(), url: cfg.files_url ?? '' });
      return cfg.files_url ?? '';
    } catch {
      return hit?.url ?? '';
    }
  };

  return {
    async discover(rawHost: string, refresh: boolean) {
      const host = rawHost.trim().toLowerCase();
      const out: { host: string; filesUrl?: string; source?: 'well-known' | 'auth' | 'home'; error?: string } = { host };
      if (!host) return out;
      const d = await deps.discoverer.discover(host, refresh);
      let raw = d.files ?? '';
      let source: 'well-known' | 'auth' | undefined = raw ? 'well-known' : undefined;
      if (!raw && d.auth) {
        raw = await authFilesUrl(d.auth, refresh);
        if (raw) source = 'auth';
      }
      if (!raw) return out;
      const t = trust(raw);
      if (typeof t !== 'string') return { ...out, error: t.error };
      return { ...out, filesUrl: t, source };
    },

    async home(refresh: boolean) {
      const out: { host: string; filesUrl?: string; source?: 'home'; error?: string } = { host: originOf(deps.mainAuthUrl) };
      const raw = await authFilesUrl(deps.mainAuthUrl, refresh);
      if (!raw) return out;
      const t = trust(raw);
      if (typeof t !== 'string') return { ...out, error: t.error };
      return { ...out, filesUrl: t, source: 'home' as const };
    },

    async request(call: { filesUrl: string; method: string; path: string; auth?: string }) {
      const base = trustedBase(call.filesUrl);
      if (!base) return { status: 0, error: 'not a files host' };
      const method = call.method.toUpperCase();
      if (!CALLS.has(`${method} ${call.path}`)) return { status: 0, error: 'not a files call' };
      const auth = cleanAuth(call.auth);
      if (auth === null) return { status: 0, error: 'bad credentials' };
      try {
        const res = await fetch(base + call.path, {
          method, credentials: 'omit',
          headers: { Accept: 'application/json', ...(auth ? { Authorization: auth } : {}) },
        });
        return { status: res.status, body: (await res.text()).slice(0, 64 << 10) };
      } catch (err) {
        return { status: 0, error: String(err) };
      }
    },

    async beginUpload(req: { filesUrl: string; auth?: string; name: string; type?: string; size: number }) {
      const base = trustedBase(req.filesUrl);
      if (!base) return { error: 'not a files host' };
      const auth = cleanAuth(req.auth);
      if (auth === null) return { error: 'bad credentials' };
      if (!(req.size > 0)) return { error: 'empty file' };
      const type = req.type && req.type.length <= 255 && !/[\r\n]/.test(req.type) ? req.type : 'application/octet-stream';
      const id = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');
      pending.set(id, { base, auth, name: cleanName(req.name), type, size: req.size });
      return { id, path: `web-upload:${id}` };
    },

    // The web's own upload: the whole file in one POST to the files host
    // (files.service.ts uses it when the bridge has it, instead of the
    // desktop's chunks to the shell).
    upload(id: string, file: Blob, signal: AbortSignal): Promise<Response> {
      const p = pending.get(id);
      if (!p) return Promise.resolve(new Response(JSON.stringify({ error: 'upload_failed', message: 'unknown upload' }), { status: 400 }));
      return new Promise<Response>((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        p.xhr = xhr;
        xhr.open('POST', `${p.base}/v1/files`);
        xhr.setRequestHeader('Content-Type', p.type);
        xhr.setRequestHeader('X-Filename', encodeURIComponent(p.name));
        xhr.setRequestHeader('Accept', 'application/json');
        if (p.auth) xhr.setRequestHeader('Authorization', p.auth);
        let last = 0;
        xhr.upload.onprogress = (ev) => {
          const now = Date.now();
          if (now - last < 100 && ev.loaded < p.size) return;
          last = now;
          emit(id, Math.min(ev.loaded, p.size), p.size);
        };
        const done = (): void => { pending.delete(id); };
        xhr.onload = () => {
          done();
          if (xhr.status >= 200 && xhr.status < 300) emit(id, p.size, p.size);
          const headers = new Headers({ 'Content-Type': 'application/json' });
          const ra = xhr.getResponseHeader('Retry-After');
          if (ra) headers.set('Retry-After', ra);
          resolve(new Response(xhr.responseText, { status: xhr.status || 502, headers }));
        };
        xhr.onerror = () => { done(); reject(new TypeError('upload failed')); };
        xhr.onabort = () => { done(); reject(new DOMException('aborted', 'AbortError')); };
        signal.addEventListener('abort', () => xhr.abort(), { once: true });
        emit(id, 0, p.size);
        xhr.send(file);
      });
    },

    async cancelUpload(id: string) {
      pending.get(id)?.xhr?.abort();
      pending.delete(id);
    },

    onProgress(fn: (p: { id: string; sent: number; total: number }) => void) {
      progress.add(fn);
      return () => { progress.delete(fn); };
    },

    // Previews come from the files host itself.
    viewUrl: (url: string) => url,
  };
}
