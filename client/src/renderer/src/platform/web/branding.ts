// window.bosonBranding on the web (desktop/branding.go): network theme
// documents and their images, fetched by the browser (auth's /v1/branding
// and its assets are public, CORS *). https only, except loopback http in
// e2e builds; images by type and size, as the desktop checks them.
const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/avif', 'image/svg+xml'];
const IMAGE_MAX = 4 << 20;
const DOC_MAX = 256 << 10;

function allowed(url: string, allowLoopbackHttp: boolean): boolean {
  try {
    const u = new URL(url);
    if (u.protocol === 'https:') return true;
    return allowLoopbackHttp && u.protocol === 'http:' && /^(127\.0\.0\.1|localhost|\[::1\])$|\.localhost$/.test(u.hostname);
  } catch {
    return false;
  }
}

function b64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export function webBrandingBridge(allowLoopbackHttp: boolean) {
  return {
    allowLoopbackHttp,
    async fetch(url: string, etag: string) {
      if (!allowed(url, allowLoopbackHttp)) return { status: 0, error: 'not an https URL' };
      try {
        const res = await fetch(url, { headers: { Accept: 'application/json', ...(etag ? { 'If-None-Match': etag } : {}) }, credentials: 'omit' });
        if (res.status !== 200) return { status: res.status };
        const body = await res.text();
        if (body.length > DOC_MAX) return { status: 0, error: 'theme document too large' };
        return { status: 200, etag: res.headers.get('ETag') ?? undefined, body };
      } catch (err) {
        return { status: 0, error: String(err) };
      }
    },
    async image(url: string) {
      if (!allowed(url, allowLoopbackHttp)) return { error: 'not an https URL' };
      try {
        const res = await fetch(url, { credentials: 'omit' });
        if (!res.ok) return { error: `HTTP ${res.status}` };
        const type = (res.headers.get('Content-Type') ?? '').split(';')[0]!.trim().toLowerCase();
        if (!IMAGE_TYPES.includes(type)) return { error: 'not an image' };
        const buf = await res.arrayBuffer();
        if (buf.byteLength > IMAGE_MAX) return { error: 'image too large' };
        return { contentType: type, data: b64(buf) };
      } catch (err) {
        return { error: String(err) };
      }
    },
  };
}
