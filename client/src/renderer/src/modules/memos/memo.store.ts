import type { Memo, MemoListener } from './memo.types';

// Persistent cross-server inbox. Stores every MemoServ NOTICE the
// renderer has received for the signed-in user, regardless of which
// server it came from. Pages of the UI subscribe to render the badge
// + the Inbox modal.
//
// Storage shape: a flat array under `boson.memos.<userId>`. The user
// scoping keeps account A's memos from leaking into account B's view
// when the same Electron install hosts multiple identities (rare but
// supported by our auth + identity flow).
//
// Design choices:
//   - localStorage rather than IndexedDB: memos are small (a few KB
//     per entry, capped at MAX_ENTRIES) and the surface API is
//     synchronous, which keeps the subscribe-and-render path on the
//     UI thread simple. The MemoStore is the only writer; reads stay
//     consistent.
//   - We DON'T parse Atheme vs Anope memo banners here. The store is
//     a verbatim log; the inbox UI is happy to display the raw text
//     line by line, grouped by server + timestamp.
//   - Read state is per-Boson-install (not per-network). When the
//     user opens the Inbox modal we flip every loaded memo to read=true.

export interface MemoStore {
  list(): ReadonlyArray<Memo>;
  unreadCount(): number;
  // Append a fresh memo. Returns the entry's id so the caller can
  // correlate later (e.g. a parser that lifts the sender out of the
  // body could update the entry, future feature).
  append(input: Omit<Memo, 'id' | 'read'>): string;
  // Insert-or-update a structured MemoServ entry, deduped on
  // (serverId, sender, memoDate). Called repeatedly from LIST output —
  // reconnects re-LIST the same memos, so a plain append would pile up
  // duplicates. On a match we refresh the (shifting) memoIndex and keep
  // the existing read state + any already-fetched body. Returns the id.
  upsertMemo(input: Omit<Memo, 'id'>): string;
  // Fill a memo's body once it's been fetched via `READ <n>`, matched by
  // (serverId, memoIndex). Sets `text` + `bodyFetched = true`. No-op if
  // no matching entry exists.
  fillMemoBody(serverId: string, memoIndex: number, body: string): void;
  // Remove a single entry by id (the Inbox per-row dismiss). No-op if
  // the id isn't present.
  remove(id: string): void;
  // Mark every memo as read. Called from the Inbox UI on open. No-op
  // if nothing was unread.
  markAllRead(): void;
  // Wipe the store. Called on sign-out from the user's account so
  // memos don't leak across identity switches on the same device.
  clear(): void;
  // Subscribe to changes. Listener fires synchronously on every
  // mutation; called immediately with the current list so consumers
  // don't need a separate `list()` call after subscribing.
  subscribe(fn: MemoListener): () => void;
  // Update the user-scope key. App shell calls this when the auth
  // identity resolves so the inbox shows the right user's memos.
  setUserId(userId: string): void;
}

// Hard cap on retained memos to keep localStorage well under the ~5MB
// per-origin limit and bound the size of the JSON payload we
// serialise on every write. Oldest entries are evicted first.
const MAX_ENTRIES = 500;
const KEY_PREFIX = 'boson.memos.';

export class LocalStorageMemoStore implements MemoStore {
  private memos: Memo[] = [];
  private readonly listeners = new Set<MemoListener>();
  private nextLocalSeq = 0;

  // userId scopes the storage key so two accounts on the same device
  // can't see each other's memos. Empty string is allowed (guest /
  // not-yet-loaded), and just keeps everything in-memory by tagging
  // with an empty scope — we still namespace in localStorage so a
  // future sign-in can read those memos out and migrate.
  constructor(
    private userId: string,
    private readonly storage: Storage = localStorage,
  ) {
    this.memos = this.load();
  }

  // Allow callers to swap in a fresh userId after the initial mount
  // (the auth state typically resolves async). Reloads from storage
  // to surface the right user's inbox.
  setUserId(userId: string): void {
    if (this.userId === userId) return;
    this.userId = userId;
    this.memos = this.load();
    this.emit();
  }

  list(): ReadonlyArray<Memo> {
    return this.memos;
  }

  unreadCount(): number {
    let n = 0;
    for (const m of this.memos) if (!m.read) n += 1;
    return n;
  }

  append(input: Omit<Memo, 'id' | 'read'>): string {
    const id = `${input.serverId}:${input.timestamp}:${this.nextLocalSeq++}`;
    const memo: Memo = { ...input, id, read: false };
    this.memos = [...this.memos, memo];
    // Evict the oldest entries when we exceed the cap. The list is
    // append-only and sorted by arrival time, so chopping the head
    // drops the right ones.
    if (this.memos.length > MAX_ENTRIES) {
      this.memos = this.memos.slice(this.memos.length - MAX_ENTRIES);
    }
    this.save();
    this.emit();
    return id;
  }

  upsertMemo(input: Omit<Memo, 'id'>): string {
    const existing = this.memos.find(
      (m) => m.kind === 'memo'
        && m.serverId === input.serverId
        && m.sender === input.sender
        && m.memoDate === input.memoDate,
    );
    if (existing) {
      // Refresh the volatile index; preserve read state + fetched body.
      this.memos = this.memos.map((m) =>
        m.id === existing.id
          ? {
              ...m,
              memoIndex: input.memoIndex,
              serverName: input.serverName || m.serverName,
              // Keep a body we already fetched; otherwise take the input's.
              text: m.bodyFetched ? m.text : input.text,
              bodyFetched: m.bodyFetched || Boolean(input.bodyFetched),
            }
          : m,
      );
      this.save();
      this.emit();
      return existing.id;
    }
    const id = `${input.serverId}:${input.timestamp}:${this.nextLocalSeq++}`;
    const memo: Memo = { ...input, id };
    this.memos = [...this.memos, memo];
    if (this.memos.length > MAX_ENTRIES) {
      this.memos = this.memos.slice(this.memos.length - MAX_ENTRIES);
    }
    this.save();
    this.emit();
    return id;
  }

  fillMemoBody(serverId: string, memoIndex: number, body: string): void {
    let changed = false;
    this.memos = this.memos.map((m) => {
      if (m.kind === 'memo' && m.serverId === serverId && m.memoIndex === memoIndex && !m.bodyFetched) {
        changed = true;
        return { ...m, text: body, bodyFetched: true };
      }
      return m;
    });
    if (!changed) return;
    this.save();
    this.emit();
  }

  markAllRead(): void {
    let changed = false;
    this.memos = this.memos.map((m) => {
      if (m.read) return m;
      changed = true;
      return { ...m, read: true };
    });
    if (!changed) return;
    this.save();
    this.emit();
  }

  remove(id: string): void {
    const next = this.memos.filter((m) => m.id !== id);
    if (next.length === this.memos.length) return; // not found — no-op
    this.memos = next;
    this.save();
    this.emit();
  }

  clear(): void {
    if (this.memos.length === 0) return;
    this.memos = [];
    this.save();
    this.emit();
  }

  subscribe(fn: MemoListener): () => void {
    this.listeners.add(fn);
    // Synchronous initial fire so subscribers don't have to special-
    // case "I just mounted, do I have data?". Isolate exceptions the
    // same way emit() does — one bad subscriber shouldn't bubble out
    // and break unrelated callers.
    try { fn(this.memos); } catch { /* isolate */ }
    return () => { this.listeners.delete(fn); };
  }

  // ---- internals ----

  private storageKey(): string {
    return KEY_PREFIX + (this.userId || '__guest__');
  }

  private load(): Memo[] {
    const raw = this.storage.getItem(this.storageKey());
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (!Array.isArray(parsed)) return [];
      // Trust the shape — we control writes. Defensive map just guards
      // against legacy schemas if we change Memo later.
      return parsed.filter((m): m is Memo =>
        m !== null && typeof m === 'object'
          && typeof (m as Memo).id === 'string'
          && typeof (m as Memo).serverId === 'string'
          && typeof (m as Memo).text === 'string',
      );
    } catch {
      // Corrupt entry — drop it. Better to lose history than crash
      // the app on every render.
      this.storage.removeItem(this.storageKey());
      return [];
    }
  }

  private save(): void {
    try {
      this.storage.setItem(this.storageKey(), JSON.stringify(this.memos));
    } catch {
      // Quota exceeded or storage disabled — silently drop. The
      // memos are still in-memory for this session; we just can't
      // persist them. Better than crashing.
    }
  }

  private emit(): void {
    for (const fn of this.listeners) {
      try { fn(this.memos); } catch { /* isolate */ }
    }
  }
}

// Module-level singleton — wired by buildApp() at startup with the
// current userId. ChatService grabs this on construction so we don't
// have to thread the store through every layer.
let store: MemoStore = new LocalStorageMemoStore('');

export function getMemoStore(): MemoStore {
  return store;
}

export function setMemoStore(next: MemoStore): void {
  store = next;
}
