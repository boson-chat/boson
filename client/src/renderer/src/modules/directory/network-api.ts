import { HttpClient, HttpError, type TokenProvider } from '../../shared/http/http.client';
import type { ApiTransport } from '../../shared/http/transport';
import type {
  DirectorySourceRef,
  RegisterServerInput,
  Server,
  ServerWithToken,
  VerifyResponse,
} from './directory.types';
import type { DirectorySource } from './sources';

// Client for one directory's /v1 API (the standalone, federated directory at
// directory.boson.chat and its self-hosted peers). Rows come back mapped onto
// the client's `Server` shape so the browse grid, the hosting modal and the
// owner edit tab work unchanged.

export type NetworkSort = 'users' | 'active' | 'newest' | 'name';

export interface ListNetworksParams {
  q?: string;
  lang?: string;
  tag?: string;
  nsfw?: boolean;
  sort?: NetworkSort;
  limit?: number;
  cursor?: string | null;
}

export interface NetworkPage {
  servers: Server[];
  nextCursor: string | null;
  totalEstimate: number | null;
}

export interface FacetCount { value: string; count: number }
export interface Facets { tags: FacetCount[]; languages: FacetCount[] }

// The calls the hosting modal and the owner edit tab make. Implemented by
// NetworkOwnerApi (/v1 on a chosen directory) and, structurally, by the
// legacy DirectoryService (/servers on the boson API).
export interface HostingApi {
  listMyServers(): Promise<ServerWithToken[]>;
  registerServer(input: RegisterServerInput): Promise<ServerWithToken>;
  verifyServer(serverID: string): Promise<VerifyResponse>;
  regenerateServerToken(serverID: string): Promise<ServerWithToken>;
  updateServerProfile(
    serverID: string,
    patch: { name?: string; description?: string; tags?: string[]; languages?: string[]; is_nsfw?: boolean },
  ): Promise<ServerWithToken>;
  uploadServerImage(serverID: string, kind: 'icon' | 'banner', image: Blob): Promise<Server>;
  deleteServerImage(serverID: string, kind: 'icon' | 'banner'): Promise<Server>;
  deleteServer?(serverID: string): Promise<void>;
  // False when deleteServer exists but can't be used right now.
  supportsDelete?(): boolean;
}

const NO_TOKEN: TokenProvider = { getToken: async () => null };

export function sourceRef(src: DirectorySource): DirectorySourceRef {
  return { url: src.url, name: src.name, isDefault: src.isDefault };
}

type Json = Record<string, unknown>;

const s = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined);
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

function status(n: Json): Server['verification_status'] {
  const v = s(n['status']) ?? s(n['verification_status']);
  return v === 'verified' || v === 'lapsed' || v === 'blocked' ? v : 'pending';
}

function health(v: unknown): Server['health_status'] {
  return v === 'up' || v === 'down' ? v : 'unknown';
}

// One /v1 network object → the client's Server (+ the owner-only token
// fields when present). Tolerant of the few names that might differ.
export function networkToServer(n: Json, source?: DirectorySourceRef): ServerWithToken {
  const userCount = typeof n['user_count'] === 'number' ? (n['user_count'] as number) : undefined;
  const token = s(n['verification_token']);
  const issued = s(n['token_issued_at']) ?? s(n['verification_token_issued_at']);
  return {
    id: String(n['id'] ?? ''),
    hostname: String(n['hostname'] ?? '').toLowerCase(),
    port: typeof n['port'] === 'number' ? (n['port'] as number) : 6697,
    tls: n['tls'] !== false,
    name: s(n['name']) ?? String(n['hostname'] ?? ''),
    ...(s(n['description']) ? { description: s(n['description']) } : {}),
    tags: strs(n['tags']),
    languages: strs(n['languages']),
    is_nsfw: n['is_nsfw'] === true,
    is_featured: n['is_featured'] === true,
    verification_status: status(n),
    health_status: health(n['health_status']),
    ...(userCount !== undefined ? { user_count: userCount } : {}),
    registered_at: s(n['created_at']) ?? s(n['registered_at']) ?? new Date(0).toISOString(),
    ...(s(n['icon_url']) ? { icon_url: s(n['icon_url']) } : {}),
    ...(s(n['banner_url']) ? { banner_url: s(n['banner_url']) } : {}),
    ...(s(n['website_url']) ? { website_url: s(n['website_url']) } : {}),
    ...(source ? { source } : {}),
    ...(token ? { verification_token: token } : {}),
    ...(issued ? { verification_token_issued_at: issued } : {}),
  };
}

// Owner responses may wrap the row ({network, verification_token}) or be the
// row itself; the token can sit beside it.
function unwrapNetwork(res: unknown, source?: DirectorySourceRef): ServerWithToken {
  const o = (res && typeof res === 'object' ? res : {}) as Json;
  const inner = (o['network'] ?? o['server']) as Json | undefined;
  if (inner && typeof inner === 'object') {
    const merged: Json = { ...inner };
    if (o['verification_token'] && !merged['verification_token']) merged['verification_token'] = o['verification_token'];
    if (o['token_issued_at'] && !merged['token_issued_at']) merged['token_issued_at'] = o['token_issued_at'];
    return networkToServer(merged, source);
  }
  return networkToServer(o, source);
}

function facetList(v: unknown, keys: string[]): FacetCount[] {
  const out: FacetCount[] = [];
  if (Array.isArray(v)) {
    for (const item of v) {
      if (typeof item === 'string') { out.push({ value: item, count: 0 }); continue; }
      if (!item || typeof item !== 'object') continue;
      const o = item as Json;
      const value = keys.map((k) => s(o[k])).find(Boolean);
      if (value) out.push({ value, count: typeof o['count'] === 'number' ? (o['count'] as number) : 0 });
    }
  } else if (v && typeof v === 'object') {
    for (const [value, count] of Object.entries(v as Json)) {
      out.push({ value, count: typeof count === 'number' ? count : 0 });
    }
  }
  return out;
}

export function parseFacets(res: unknown): Facets {
  const o = (res && typeof res === 'object' ? res : {}) as Json;
  return {
    tags: facetList(o['tags'], ['tag', 'value', 'name']),
    languages: facetList(o['languages'], ['language', 'lang', 'code', 'value', 'name']),
  };
}

export function listQuery(p: ListNetworksParams): string {
  const qs = new URLSearchParams();
  if (p.q) qs.set('q', p.q);
  if (p.lang) qs.set('lang', p.lang);
  if (p.tag) qs.set('tag', p.tag);
  if (p.nsfw) qs.set('nsfw', 'true');
  if (p.sort) qs.set('sort', p.sort);
  if (p.limit) qs.set('limit', String(p.limit));
  if (p.cursor) qs.set('cursor', p.cursor);
  const q = qs.toString();
  return q ? `?${q}` : '';
}

// Public, unauthenticated reads. Never carries our access token: a
// user-added directory is someone else's server.
export class NetworkDirectoryApi {
  readonly ref: DirectorySourceRef;
  private readonly http: HttpClient;

  constructor(readonly source: DirectorySource, transport?: ApiTransport) {
    this.ref = sourceRef(source);
    this.http = new HttpClient(source.apiBase, NO_TOKEN, transport);
  }

  async listNetworks(p: ListNetworksParams = {}): Promise<NetworkPage> {
    const res = await this.http.get<Json>(`/v1/networks${listQuery(p)}`);
    const rows = Array.isArray(res?.['networks']) ? (res['networks'] as Json[]) : [];
    const next = s(res?.['next_cursor']) ?? null;
    const total = typeof res?.['total_estimate'] === 'number' ? (res['total_estimate'] as number) : null;
    return { servers: rows.map((n) => networkToServer(n, this.ref)), nextCursor: next, totalEstimate: total };
  }

  async facets(p: { nsfw?: boolean } = {}): Promise<Facets> {
    return parseFacets(await this.http.get<unknown>(`/v1/facets${p.nsfw ? '?nsfw=true' : ''}`));
  }
}

// Owner calls on one directory, with the user's boson access token. Only
// built for directories that accept our accounts (DirectorySources.hostable).
export class NetworkOwnerApi implements HostingApi {
  readonly ref: DirectorySourceRef;
  private readonly http: HttpClient;

  constructor(readonly source: DirectorySource, tokens: TokenProvider, transport?: ApiTransport) {
    this.ref = sourceRef(source);
    this.http = new HttpClient(source.apiBase, tokens, transport);
  }

  async listMyServers(): Promise<ServerWithToken[]> {
    const res = await this.http.get<Json>('/v1/me/networks');
    const rows = Array.isArray(res?.['networks']) ? (res['networks'] as Json[]) : [];
    return rows.map((n) => ({ ...networkToServer(n, this.ref), owned: true }));
  }

  async registerServer(input: RegisterServerInput): Promise<ServerWithToken> {
    return { ...unwrapNetwork(await this.http.post<unknown>('/v1/networks', input), this.ref), owned: true };
  }

  async regenerateServerToken(id: string): Promise<ServerWithToken> {
    return { ...unwrapNetwork(await this.http.post<unknown>(`/v1/networks/${encodeURIComponent(id)}/regenerate-token`, null), this.ref), owned: true };
  }

  async updateServerProfile(
    id: string,
    patch: { name?: string; description?: string; tags?: string[]; languages?: string[]; is_nsfw?: boolean },
  ): Promise<ServerWithToken> {
    return { ...unwrapNetwork(await this.http.patch<unknown>(`/v1/networks/${encodeURIComponent(id)}`, patch), this.ref), owned: true };
  }

  async uploadServerImage(id: string, kind: 'icon' | 'banner', image: Blob): Promise<Server> {
    const res = await this.http.putBlob<unknown>(`/v1/networks/${encodeURIComponent(id)}/${kind}`, image, image.type || 'application/octet-stream');
    return { ...unwrapNetwork(res, this.ref), owned: true };
  }

  async deleteServerImage(id: string, kind: 'icon' | 'banner'): Promise<Server> {
    return { ...unwrapNetwork(await this.http.delete<unknown>(`/v1/networks/${encodeURIComponent(id)}/${kind}`), this.ref), owned: true };
  }

  async deleteServer(id: string): Promise<void> {
    await this.http.delete(`/v1/networks/${encodeURIComponent(id)}`);
  }

  // Same contract as the legacy verify: the report comes back on success and
  // on a 409 partial match alike; 410/403/404/429 throw.
  async verifyServer(id: string): Promise<VerifyResponse> {
    let body: unknown;
    try {
      body = await this.http.post<unknown>(`/v1/networks/${encodeURIComponent(id)}/verify`, null);
    } catch (err) {
      if (err instanceof HttpError && err.status === 409 && err.body && typeof err.body === 'object') body = err.body;
      else throw err;
    }
    const o = (body && typeof body === 'object' ? body : {}) as Json;
    const report = (o['report'] && typeof o['report'] === 'object' ? o['report'] : { success: false, results: {} }) as VerifyResponse['report'];
    const success = o['success'] === true || report.success === true;
    return { server: { ...unwrapNetwork(o, this.ref), owned: true }, report, success };
  }
}
