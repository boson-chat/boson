import { HttpError } from '../../shared/http/http.client';
import type { ApiTransport } from '../../shared/http/transport';
import type { ListServersParams } from './directory.service';
import type { Server } from './directory.types';
import {
  NetworkDirectoryApi,
  type FacetCount,
  type Facets,
  type NetworkSort,
} from './network-api';
import type { DirectorySource } from './sources';

// What the directory screen browses through: one search at a time, paged.
// MultiDirectory fans out to every enabled directory and merges; the legacy
// browser wraps the boson API's single /servers page (old deployments, and
// the bloc's default when no browser is injected).

export interface BrowseParams {
  q?: string;
  lang?: string;
  tag?: string;
  nsfw?: boolean;
  sort?: NetworkSort;
}

export interface BrowsePage {
  servers: Server[];
  hasMore: boolean;
  // Directories that failed this round (the others' rows still show).
  failures: Array<{ source: string; message: string }>;
  // True when the rows came from the legacy /servers fallback.
  legacy: boolean;
}

export interface DirectoryBrowser {
  // Language / tag / sort are applied by the directory (refetch on change)
  // rather than by filtering the loaded rows.
  readonly serverSideFilters: boolean;
  search(params: BrowseParams): Promise<BrowsePage>;
  // Next page of the current search; appends. Resolves to the whole list.
  loadMore(): Promise<BrowsePage>;
  facets?(params: { nsfw?: boolean }): Promise<Facets>;
}

// The pre-/v1 behaviour: one GET /servers with q + nsfw; language is a
// client-side filter; no further pages.
export class LegacyBrowser implements DirectoryBrowser {
  readonly serverSideFilters = false;
  private last: Server[] = [];

  constructor(private readonly list: (p?: ListServersParams) => Promise<Server[]>) {}

  async search(params: BrowseParams): Promise<BrowsePage> {
    const p: ListServersParams = {};
    if (params.q) p.q = params.q;
    if (params.nsfw) p.nsfw = true;
    this.last = await (Object.keys(p).length ? this.list(p) : this.list());
    return { servers: this.last, hasMore: false, failures: [], legacy: true };
  }

  async loadMore(): Promise<BrowsePage> {
    return { servers: this.last, hasMore: false, failures: [], legacy: true };
  }
}

export function serverKey(s: { hostname: string; port: number }): string {
  return `${s.hostname.trim().toLowerCase().replace(/\.$/, '')}:${s.port}`;
}

// Merge rows from several directories, one per hostname:port. The winner is
// the verified one, then the default directory's, then whichever came first;
// the other directories that list it are kept for the card's badge.
// `owned` sticks if any copy is owned.
export function mergeListings(lists: ReadonlyArray<ReadonlyArray<Server>>): Server[] {
  const order: string[] = [];
  const best = new Map<string, Server>();
  const names = new Map<string, Set<string>>();
  const rank = (s: Server): number => (s.verification_status === 'verified' ? 2 : 0) + (s.source?.isDefault ? 1 : 0);
  // Round-robin across the lists so no directory's rows all sink below
  // another's when nothing re-sorts them.
  const longest = Math.max(0, ...lists.map((l) => l.length));
  for (let i = 0; i < longest; i++) {
    for (const list of lists) {
      const row = list[i];
      if (!row) continue;
      const key = serverKey(row);
      const seen = best.get(key);
      if (row.source) {
        const set = names.get(key) ?? new Set<string>();
        set.add(row.source.name);
        names.set(key, set);
      }
      if (!seen) {
        order.push(key);
        best.set(key, row);
      } else {
        const owned = seen.owned || row.owned;
        const winner = rank(row) > rank(seen) ? row : seen;
        best.set(key, owned ? { ...winner, owned: true } : winner);
      }
    }
  }
  return order.map((key) => {
    const row = best.get(key)!;
    const others = [...(names.get(key) ?? [])].filter((n) => n !== row.source?.name);
    return others.length ? { ...row, also_listed_on: others } : row;
  });
}

// Several directories each answer in their own order; put the merged rows
// back in the requested one.
export function sortMerged(rows: Server[], sort: NetworkSort | undefined): Server[] {
  const out = rows.slice();
  switch (sort) {
    case 'users':
      return out.sort((a, b) => (b.user_count ?? -1) - (a.user_count ?? -1));
    case 'newest':
      return out.sort((a, b) => Date.parse(b.registered_at) - Date.parse(a.registered_at));
    case 'name':
      return out.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
    default:
      return out;
  }
}

export function mergeFacets(all: ReadonlyArray<Facets>): Facets {
  const sum = (pick: (f: Facets) => FacetCount[]): FacetCount[] => {
    const m = new Map<string, number>();
    for (const f of all) for (const c of pick(f)) m.set(c.value, (m.get(c.value) ?? 0) + c.count);
    return [...m.entries()].map(([value, count]) => ({ value, count })).sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));
  };
  return { tags: sum((f) => f.tags), languages: sum((f) => f.languages) };
}

// "Unreachable" for the fallback: no answer, a server error, or a 404 from
// an api host that has no /v1 yet. A 4xx like 400 is the directory
// answering, so it isn't.
export function unreachable(err: unknown): boolean {
  if (!(err instanceof HttpError)) return true;
  return err.status === 0 || err.status === 404 || err.status >= 500;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

interface SourceCursor {
  api: NetworkDirectoryApi;
  rows: Server[];
  cursor: string | null;
  done: boolean;
  failed: string | null;
}

export interface MultiDirectoryOptions {
  // The directories to browse, read on every new search.
  sources: () => ReadonlyArray<DirectorySource>;
  // Resolves when the transport may reach them (the desktop proxy's list).
  ready?: () => Promise<void>;
  transport?: ApiTransport;
  // Legacy GET {VITE_BOSON_API_URL}/servers, used when no directory answers.
  legacy?: (p?: ListServersParams) => Promise<Server[]>;
  pageSize?: number;
  // ids of the rows the user owns, per directory url (from /v1/me/networks).
  owned?: () => ReadonlyMap<string, ReadonlySet<string>>;
}

export class MultiDirectory implements DirectoryBrowser {
  readonly serverSideFilters = true;
  private readonly opts: MultiDirectoryOptions;
  private params: BrowseParams = {};
  private cursors: SourceCursor[] = [];
  private legacyMode = false;
  private legacyRows: Server[] = [];
  private generation = 0;
  private more: Promise<BrowsePage> | null = null;

  constructor(opts: MultiDirectoryOptions) {
    this.opts = opts;
  }

  private get pageSize(): number { return this.opts.pageSize ?? 25; }

  async search(params: BrowseParams): Promise<BrowsePage> {
    const gen = ++this.generation;
    this.params = { ...params };
    this.more = null;
    this.legacyMode = false;
    await this.opts.ready?.();
    if (gen !== this.generation) return this.current();
    const sources = this.opts.sources().filter((s) => s.enabled);
    const cursors: SourceCursor[] = sources.map((src) => ({
      api: new NetworkDirectoryApi(src, this.opts.transport),
      rows: [], cursor: null, done: false, failed: null,
    }));
    const errors = await Promise.all(cursors.map((c) => this.fetchPage(c)));
    if (gen !== this.generation) return this.current();
    this.cursors = cursors;
    if (cursors.length > 0 && errors.every((e) => e !== null && unreachable(e)) && this.opts.legacy) {
      return this.searchLegacy(params, gen);
    }
    return this.current();
  }

  private async searchLegacy(params: BrowseParams, gen: number): Promise<BrowsePage> {
    const p: ListServersParams = {};
    if (params.q) p.q = params.q;
    if (params.lang) p.lang = params.lang;
    if (params.nsfw) p.nsfw = true;
    if (params.sort && params.sort !== 'name') p.sort = params.sort;
    try {
      const rows = await (Object.keys(p).length ? this.opts.legacy!(p) : this.opts.legacy!());
      if (gen !== this.generation) return this.current();
      this.legacyMode = true;
      this.legacyRows = params.tag ? rows.filter((r) => r.tags.includes(params.tag!)) : rows;
      return this.current();
    } catch (err) {
      // Neither answered: report the directory's failure, not the legacy one.
      if (gen !== this.generation) return this.current();
      throw new Error(this.cursors[0]?.failed ?? messageOf(err));
    }
  }

  // Fetch the next page for one directory; returns the error, or null.
  private async fetchPage(c: SourceCursor): Promise<unknown> {
    try {
      const page = await c.api.listNetworks({ ...this.params, limit: this.pageSize, cursor: c.cursor });
      c.rows = c.rows.concat(page.servers);
      c.cursor = page.nextCursor;
      c.done = !page.nextCursor || page.servers.length === 0;
      c.failed = null;
      return null;
    } catch (err) {
      c.failed = messageOf(err);
      // A failed first page ends that directory for this search; a failed
      // later page can be retried by the next loadMore.
      if (c.rows.length === 0) c.done = true;
      return err;
    }
  }

  loadMore(): Promise<BrowsePage> {
    if (this.legacyMode) return Promise.resolve(this.current());
    if (this.more) return this.more;
    const gen = this.generation;
    const pending = this.cursors.filter((c) => !c.done);
    this.more = Promise.all(pending.map((c) => this.fetchPage(c))).then(() => {
      if (gen === this.generation) this.more = null;
      return this.current();
    });
    return this.more;
  }

  // The merged rows loaded so far (re-merged, e.g. after ownership changes).
  current(): BrowsePage {
    if (this.legacyMode) {
      return { servers: this.legacyRows, hasMore: false, failures: [], legacy: true };
    }
    const owned = this.opts.owned?.();
    const lists = this.cursors.map((c) => {
      const mine = owned?.get(c.api.source.url);
      return mine?.size ? c.rows.map((r) => (mine.has(r.id) ? { ...r, owned: true } : r)) : c.rows;
    });
    return {
      servers: sortMerged(mergeListings(lists), this.params.sort),
      hasMore: this.cursors.some((c) => !c.done),
      failures: this.cursors.filter((c) => c.failed).map((c) => ({ source: c.api.source.name, message: c.failed! })),
      legacy: false,
    };
  }

  async facets(params: { nsfw?: boolean } = {}): Promise<Facets> {
    const sources = this.opts.sources().filter((s) => s.enabled);
    const all = await Promise.all(sources.map((src) =>
      new NetworkDirectoryApi(src, this.opts.transport).facets(params).catch(() => null)));
    return mergeFacets(all.filter((f): f is Facets => f !== null));
  }
}
