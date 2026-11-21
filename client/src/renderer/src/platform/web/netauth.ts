// window.bosonNetAuth on the web (desktop/netauth.go): which auth service
// an IRC network uses ("Sign in to <network>"), from its boson.json
// (discovery.ts), and "Use another server" lookups. The desktop also
// allowlists the service for its API proxy; on the web the browser talks
// to it directly (the service's CORS allows the app's origin).
import { cleanBaseUrl, discoveryDomain, type NetworkDiscoverer, type NetworkIRC } from './discovery';

export interface WebNetAuthDeps {
  discoverer: NetworkDiscoverer;
  // The app's own auth service, API and directory (a network may not name
  // the API or directory as its sign-in service).
  mainAuthUrl: string;
  appOrigins: string[];
}

function originOf(u: string): string {
  try { return new URL(u).origin; } catch { return ''; }
}

const PRIVATE_IP = /^(127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|0\.)|^\[?(::1|f[cd][0-9a-f]{2}:|fe80:)/i;

/** What the user typed as a lower-case host name, or null (netauth.go normalizeServerAddress). */
export function normalizeServerAddress(raw: string): string | null {
  let s = raw.trim();
  if (!s || s.length > 512) return null;
  if (s.includes('://')) {
    let u: URL;
    try { u = new URL(s); } catch { return null; }
    if (!u.hostname || u.username || u.password || !['https:', 'http:', 'irc:', 'ircs:'].includes(u.protocol.toLowerCase())) return null;
    s = u.hostname;
  } else {
    s = s.split(/[/?#]/)[0]!;
    const m = /^(.*):(\d+)$/.exec(s);
    if (m) s = m[1]!;
  }
  s = s.toLowerCase().replace(/\.$/, '');
  if (!s || s.length > 253) return null;
  for (const label of s.split('.')) {
    if (!label || label.length > 63 || label.startsWith('-') || label.endsWith('-') || !/^[a-z0-9-]+$/.test(label)) return null;
  }
  return s;
}

export function webNetAuthBridge(deps: WebNetAuthDeps) {
  const mainOrigin = originOf(deps.mainAuthUrl);
  const allowHttp = deps.discoverer.allowLoopbackHttp;
  const trust = (auth: string): { base: string; main: boolean } | { error: string } => {
    const base = cleanBaseUrl(auth, allowHttp);
    if (!base) return { error: `${auth} is not an https base URL` };
    const o = originOf(base);
    if (o === mainOrigin) return { base, main: true };
    if (deps.appOrigins.includes(o)) return { error: 'not a sign-in service' };
    return { base, main: false };
  };

  const cleanIRC = (irc: NetworkIRC): NetworkIRC | { error: string } => {
    const host = irc.host.trim().toLowerCase().replace(/\.$/, '');
    if (!host || /[/@ \t]/.test(host)) return { error: 'irc.host is not a host name' };
    const port = irc.port || 6697;
    if (port < 1 || port > 65535) return { error: `irc.port ${port} is out of range` };
    if (!allowHttp && PRIVATE_IP.test(host)) return { error: 'irc.host is a private address' };
    return { host, port, tls: irc.tls };
  };

  return {
    async discover(host: string, refresh: boolean) {
      const d = await deps.discoverer.discover(host, refresh);
      const out: { host: string; authUrl?: string; directoryUrl?: string; brandingUrl?: string; main: boolean; error?: string } = {
        host: d.host, main: false, ...(d.branding ? { brandingUrl: d.branding } : {}),
      };
      if (!d.auth) return out;
      const t = trust(d.auth);
      if ('error' in t) return { ...out, error: t.error };
      return { ...out, authUrl: t.base, main: t.main, ...(d.directory ? { directoryUrl: d.directory } : {}) };
    },

    async resolve(address: string) {
      const host = normalizeServerAddress(address);
      if (!host) return { host: address.trim(), main: false, error: 'invalid' };
      const finish = (out: Record<string, unknown>, auth?: string, dir?: string) => {
        if (!auth) return { ...out, main: false, error: 'no-accounts' };
        const t = trust(auth);
        if ('error' in t) return { ...out, main: false, error: 'untrusted', detail: t.error };
        const res = { ...out, authUrl: t.base, main: t.main, ...(dir ? { directoryUrl: dir } : {}) };
        return out['irc'] ? res : { ...res, error: 'no-irc' };
      };
      const o = deps.discoverer.override(host);
      if (o?.irc) return finish({ host, domain: host, irc: o.irc, ...(o.branding ? { brandingUrl: o.branding } : {}) }, o.auth, o.directory);
      const domain = discoveryDomain(host);
      const candidates = domain ? (host !== domain ? [domain, host] : [domain]) : [];
      let answered = false;
      for (const c of candidates) {
        const d = await deps.discoverer.lookup(host, c);
        answered ||= d.answered;
        if (!d.answered || (!d.irc && !d.auth && !d.branding && !d.directory && !d.voice && !d.files)) continue;
        const out: Record<string, unknown> = { host, domain: c, ...(d.branding ? { brandingUrl: d.branding } : {}) };
        if (d.irc) {
          const irc = cleanIRC(d.irc);
          if ('error' in irc) return { ...out, main: false, error: 'no-irc', detail: irc.error };
          out['irc'] = irc;
        } else if (host !== c && discoveryDomain(host) === c) {
          out['irc'] = { host, port: 6697, tls: true };
        }
        return finish(out, d.auth, d.directory);
      }
      return { host, main: false, error: answered ? 'no-boson-json' : 'unreachable' };
    },
  };
}
