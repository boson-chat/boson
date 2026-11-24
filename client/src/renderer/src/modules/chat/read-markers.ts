// read-markers.ts — how far the user has read each conversation on a server,
// kept between runs so unread badges survive closing the app.
//
// A marker is the stamp (server-time when the server sent one, else our own
// clock) of the newest line the user has seen in that conversation. On the
// next attach, the backlog the server or bouncer replays is compared against
// it: lines newer than the marker count as unread, older ones don't. Where
// the server offers IRCv3 `draft/read-marker`, ChatService also syncs markers
// with it (MARKREAD), so reading on one client clears the badge on the others.
//
// One store per (user, server) namespace, shared by that server's
// connections. Persisted to localStorage synchronously on every change: the
// data is tiny, and a phone app can be killed at any moment.

export const READ_MARKERS_PREFIX = 'boson:read-markers:v1:';
/** Conversations remembered per namespace; the longest-unread are dropped. */
export const READ_MARKERS_CAP = 2000;

export interface ReadMarkerBackend {
  load(ns: string): Record<string, number>;
  save(ns: string, data: Record<string, number>): void;
  clear(prefix: string): void;
}

export class LocalStorageReadMarkerBackend implements ReadMarkerBackend {
  constructor(private readonly storage: Storage) {}

  load(ns: string): Record<string, number> {
    try {
      const raw = this.storage.getItem(READ_MARKERS_PREFIX + ns);
      if (!raw) return {};
      const parsed = JSON.parse(raw) as unknown;
      if (!parsed || typeof parsed !== 'object') return {};
      const out: Record<string, number> = {};
      for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
      }
      return out;
    } catch {
      return {};
    }
  }

  save(ns: string, data: Record<string, number>): void {
    try {
      this.storage.setItem(READ_MARKERS_PREFIX + ns, JSON.stringify(data));
    } catch {
      // Storage full / blocked: markers stay in memory for this run.
    }
  }

  clear(prefix: string): void {
    try {
      const doomed: string[] = [];
      for (let i = 0; i < this.storage.length; i++) {
        const k = this.storage.key(i);
        if (k && k.startsWith(READ_MARKERS_PREFIX + prefix)) doomed.push(k);
      }
      for (const k of doomed) this.storage.removeItem(k);
    } catch {
      // ignore
    }
  }
}

export class ReadMarkerStore {
  private readonly markers: Map<string, number>;

  constructor(
    readonly ns: string,
    private readonly backend: ReadMarkerBackend | null = null,
  ) {
    this.markers = new Map(Object.entries(backend?.load(ns) ?? {}));
  }

  get(key: string): number | undefined {
    return this.markers.get(key);
  }

  /** Move the marker forward to `stamp`. False (and no change) when it isn't newer. */
  advance(key: string, stamp: number): boolean {
    if (!Number.isFinite(stamp)) return false;
    const cur = this.markers.get(key);
    if (cur !== undefined && stamp <= cur) return false;
    this.write(key, stamp);
    return true;
  }

  /** Set the marker outright, even backwards (a server's word over a local guess). */
  set(key: string, stamp: number): void {
    if (!Number.isFinite(stamp) || this.markers.get(key) === stamp) return;
    this.write(key, stamp);
  }

  private write(key: string, stamp: number): void {
    // Re-insert so Map order is "least recently moved first" for eviction.
    this.markers.delete(key);
    this.markers.set(key, stamp);
    while (this.markers.size > READ_MARKERS_CAP) {
      const oldest = this.markers.keys().next().value as string;
      this.markers.delete(oldest);
    }
    this.backend?.save(this.ns, Object.fromEntries(this.markers));
  }
}

const stores = new Map<string, ReadMarkerStore>();

function defaultBackend(): ReadMarkerBackend | null {
  return typeof localStorage !== 'undefined' ? new LocalStorageReadMarkerBackend(localStorage) : null;
}

/** The (one, shared) store for a namespace, persisted to localStorage. */
export function readMarkerStoreFor(ns: string): ReadMarkerStore {
  let s = stores.get(ns);
  if (!s) {
    s = new ReadMarkerStore(ns, defaultBackend());
    stores.set(ns, s);
  }
  return s;
}

/** Forget every namespace starting with `prefix` ('' = all), in memory and on disk. */
export function clearReadMarkers(prefix = ''): void {
  for (const ns of Array.from(stores.keys())) if (ns.startsWith(prefix)) stores.delete(ns);
  defaultBackend()?.clear(prefix);
}
