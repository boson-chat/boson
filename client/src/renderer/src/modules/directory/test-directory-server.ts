import type { ApiRequest, ApiResponse, ApiTransport } from '../../shared/http/transport';

// An in-memory stand-in for the /v1 directory API (and its well-known), for
// tests and dev screenshots. Implements just enough of the contract:
// cursor paging over `networks`, q/lang/tag/nsfw filters, facets, and the
// owner endpoints for one signed-in user.

export interface FakeNetwork {
  id: string;
  hostname: string;
  port?: number;
  tls?: boolean;
  name: string;
  description?: string;
  tags?: string[];
  languages?: string[];
  is_nsfw?: boolean;
  status?: 'pending' | 'verified' | 'lapsed' | 'blocked';
  health_status?: 'up' | 'down' | 'unknown';
  user_count?: number;
  created_at?: string;
  icon_url?: string;
  owner?: string;
  verification_token?: string;
}

export interface FakeDirectory {
  origin: string;
  name: string;
  operator?: string;
  authIssuer?: string;
  networks: FakeNetwork[];
  // Answer every request with this status (0 = unreachable).
  down?: number;
  requests: ApiRequest[];
}

export function fakeDirectory(origin: string, name: string, networks: FakeNetwork[], extra: Partial<FakeDirectory> = {}): FakeDirectory {
  return { origin, name, networks, requests: [], ...extra };
}

function json(body: unknown, status = 200): ApiResponse {
  return { status, ok: status >= 200 && status < 300, statusText: String(status), text: JSON.stringify(body) };
}

function publicView(n: FakeNetwork): Record<string, unknown> {
  const { owner: _o, verification_token: _t, ...rest } = n;
  return { port: 6697, tls: true, tags: [], languages: [], is_nsfw: false, status: 'verified', health_status: 'up', ...rest };
}

export function fakeTransport(dirs: FakeDirectory[], opts: { user?: string } = {}): ApiTransport {
  return async (req) => {
    const u = new URL(req.url);
    const dir = dirs.find((d) => d.origin === u.origin);
    if (!dir) return { status: 0, ok: false, statusText: 'connection refused', text: '' };
    dir.requests.push(req);
    if (dir.down !== undefined) {
      return dir.down === 0 ? { status: 0, ok: false, statusText: 'connection refused', text: '' } : json({ error: 'down' }, dir.down);
    }
    const authed = opts.user && req.headers['Authorization'] === 'Bearer jwt' ? opts.user : null;
    const path = u.pathname;
    if (path === '/.well-known/boson-directory.json') {
      return json({ name: dir.name, api: dir.origin, version: 1, operator: dir.operator, federation: true, ...(dir.authIssuer ? { auth_issuer: dir.authIssuer } : {}) });
    }
    if (path === '/v1/networks' && req.method === 'GET') {
      const q = u.searchParams.get('q')?.toLowerCase();
      const lang = u.searchParams.get('lang');
      const tag = u.searchParams.get('tag');
      const nsfw = u.searchParams.get('nsfw') === 'true';
      const limit = Number(u.searchParams.get('limit') ?? 25);
      const start = Number(u.searchParams.get('cursor') ?? 0);
      const rows = dir.networks.filter((n) => (n.status ?? 'verified') === 'verified')
        .filter((n) => !q || n.name.toLowerCase().includes(q) || n.hostname.includes(q))
        .filter((n) => !lang || (n.languages ?? []).includes(lang))
        .filter((n) => !tag || (n.tags ?? []).includes(tag))
        .filter((n) => nsfw || !n.is_nsfw);
      const page = rows.slice(start, start + limit);
      const next = start + limit < rows.length ? String(start + limit) : null;
      return json({ networks: page.map(publicView), next_cursor: next, total_estimate: rows.length });
    }
    if (path === '/v1/facets') {
      const tags = new Map<string, number>();
      const langs = new Map<string, number>();
      for (const n of dir.networks) {
        for (const t of n.tags ?? []) tags.set(t, (tags.get(t) ?? 0) + 1);
        for (const l of n.languages ?? []) langs.set(l, (langs.get(l) ?? 0) + 1);
      }
      return json({
        tags: [...tags].map(([tag, count]) => ({ tag, count })),
        languages: [...langs].map(([language, count]) => ({ language, count })),
      });
    }
    if (!authed) return json({ error: 'unauthorized' }, 401);
    if (path === '/v1/me/networks') {
      return json({ networks: dir.networks.filter((n) => n.owner === authed).map((n) => ({ ...publicView(n), verification_token: n.verification_token })) });
    }
    if (path === '/v1/networks' && req.method === 'POST') {
      const body = JSON.parse(String(req.body)) as FakeNetwork;
      const n: FakeNetwork = { ...body, id: `net_${dir.networks.length + 1}`, status: 'pending', owner: authed, verification_token: 'tok123' };
      dir.networks.push(n);
      return json({ network: publicView(n), verification_token: n.verification_token }, 201);
    }
    const m = path.match(/^\/v1\/networks\/([^/]+)(?:\/(verify|regenerate-token|icon|banner))?$/);
    const n = m && dir.networks.find((x) => x.id === decodeURIComponent(m[1]!));
    if (!m || !n) return json({ error: 'not found' }, 404);
    if (n.owner !== authed) return json({ error: 'forbidden' }, 403);
    if (m[2] === 'verify') {
      const report = { success: true, results: { cloudflare: { outcome: 'match' } } };
      n.status = 'verified';
      return json({ network: publicView(n), report, success: true });
    }
    if (req.method === 'DELETE' && !m[2]) {
      dir.networks = dir.networks.filter((x) => x !== n);
      return { status: 204, ok: true, statusText: '204', text: '' };
    }
    if (req.method === 'PATCH') {
      Object.assign(n, JSON.parse(String(req.body)));
      return json(publicView(n));
    }
    if (m[2] === 'icon' && req.method === 'PUT') {
      n.icon_url = `${dir.origin}/media/${n.id}.png`;
      return json(publicView(n));
    }
    return json({ error: 'not found' }, 404);
  };
}
