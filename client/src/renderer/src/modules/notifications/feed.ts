// In-app notifications: the toasts on screen now, and the friend and call
// events the bell lists (mentions, DMs and memos are the memo store's, which
// the bell lists with these). Toasts are in memory; feed items persist per
// account on this device (the latest 100).
import type { Friend } from '../friends/friends.types';

// 'undo': something you just did, with Undo (left a channel).
export type ToastKind = 'mention' | 'dm' | 'message' | 'friend' | 'accepted' | 'missed' | 'started' | 'undo';

export interface ToastRoom { host: string; roomId: string; name: string; serverName: string }

export interface Toast {
  id: string;
  kind: ToastKind;
  // "kestrel", "Missed call", "Call started".
  title: string;
  // "#test · Nebula", "direct message", "General · Nebula".
  where: string;
  body: string;
  // Whose avatar (a nick, or '' for none).
  nick: string;
  at: number;
  // A message: the conversation it's in.
  serverId?: string;
  channel?: string;
  // The message (a reply opens its thread: thread-nav.ts).
  messageId?: string;
  msgid?: string;
  // A friend request: who (for Accept / Ignore).
  friend?: Friend;
  // A missed call: who to call back, and how.
  call?: { peer: string; video: boolean };
  // A call that started: its voice channel.
  room?: ToastRoom;
  // The feed item (or memo) it's for: opening it marks that read.
  feedId?: string;
  // An 'undo' toast: puts back what was just done.
  undo?: () => void;
}

export type FeedKind = 'friend' | 'call';

export interface FeedItem {
  id: string;
  kind: FeedKind;
  sub: 'request' | 'accepted' | 'missed' | 'started';
  title: string;
  where: string;
  body: string;
  nick: string;
  at: number;
  read: boolean;
  call?: { peer: string; video: boolean };
  room?: ToastRoom;
}

export const MAX_TOASTS = 3;
const MAX_ITEMS = 100;

interface Storage {
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
}

export interface FeedSnapshot {
  toasts: readonly Toast[];
  items: readonly FeedItem[];
}

export class NotificationFeed {
  private toasts: Toast[] = [];
  private items: FeedItem[] = [];
  private userId = '';
  private seq = 0;
  private listeners = new Set<(s: FeedSnapshot) => void>();
  private snap: FeedSnapshot = { toasts: [], items: [] };

  constructor(private readonly storage: Storage | null = defaultStorage()) {}

  setUserId(userId: string): void {
    if (userId === this.userId) return;
    this.userId = userId;
    this.items = this.load();
    this.emit();
  }

  getSnapshot(): FeedSnapshot { return this.snap; }

  subscribe(fn: (s: FeedSnapshot) => void): () => void {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  }

  /** Shows a toast (the newest on top, at most MAX_TOASTS); returns its id. */
  toast(t: Omit<Toast, 'id' | 'at'> & { at?: number }): string {
    const id = `t${++this.seq}`;
    this.toasts = [{ ...t, id, at: t.at ?? Date.now() }, ...this.toasts].slice(0, MAX_TOASTS);
    this.emit();
    return id;
  }

  dismiss(id: string): void {
    const next = this.toasts.filter((t) => t.id !== id);
    if (next.length === this.toasts.length) return;
    this.toasts = next;
    this.emit();
  }

  /** Adds a friend or call event to the list (same id: replaced). */
  add(item: Omit<FeedItem, 'read' | 'at'> & { at?: number; read?: boolean }): FeedItem {
    const full: FeedItem = { ...item, at: item.at ?? Date.now(), read: item.read ?? false };
    this.items = [full, ...this.items.filter((i) => i.id !== item.id)].slice(0, MAX_ITEMS);
    this.save();
    this.emit();
    return full;
  }

  has(id: string): boolean { return this.items.some((i) => i.id === id); }

  /** Marks one item (by id) or every item matching a test read. */
  markRead(which: string | ((i: FeedItem) => boolean)): void {
    const hit = typeof which === 'string' ? (i: FeedItem) => i.id === which : which;
    this.update((i) => (!i.read && hit(i) ? { ...i, read: true } : i));
  }
  markAllRead(): void { this.update((i) => (i.read ? i : { ...i, read: true })); }

  remove(id: string): void {
    const next = this.items.filter((i) => i.id !== id);
    if (next.length === this.items.length) return;
    this.items = next;
    this.save();
    this.emit();
  }

  clear(kinds?: readonly FeedKind[]): void {
    const next = kinds ? this.items.filter((i) => !kinds.includes(i.kind)) : [];
    if (next.length === this.items.length) return;
    this.items = next;
    this.save();
    this.emit();
  }

  // Sign-out: drop toasts and the list from memory and unscope (the storage
  // wipe removes the saved copy).
  clearForSignOut(): void {
    this.userId = '';
    this.toasts = [];
    this.items = [];
    this.emit();
  }

  unread(): number { return this.items.reduce((n, i) => n + (i.read ? 0 : 1), 0); }

  private update(fn: (i: FeedItem) => FeedItem): void {
    let changed = false;
    this.items = this.items.map((i) => { const n = fn(i); if (n !== i) changed = true; return n; });
    if (!changed) return;
    this.save();
    this.emit();
  }

  private key(): string | null {
    return this.userId ? `boson:notify-feed:v1:${this.userId}` : null;
  }

  private load(): FeedItem[] {
    const k = this.key();
    if (!k || !this.storage) return [];
    try {
      const raw = this.storage.getItem(k);
      const p = raw ? JSON.parse(raw) as FeedItem[] : [];
      return Array.isArray(p) ? p.filter((i) => i && typeof i.id === 'string' && (i.kind === 'friend' || i.kind === 'call')) : [];
    } catch { return []; }
  }

  private save(): void {
    const k = this.key();
    if (!k || !this.storage) return;
    try { this.storage.setItem(k, JSON.stringify(this.items)); } catch { /* best-effort */ }
  }

  private emit(): void {
    this.snap = { toasts: this.toasts, items: this.items };
    for (const fn of this.listeners) { try { fn(this.snap); } catch { /* isolate */ } }
  }
}

function defaultStorage(): Storage | null {
  return (globalThis as { localStorage?: Storage }).localStorage ?? null;
}

let feed: NotificationFeed | null = null;
export function getNotificationFeed(): NotificationFeed {
  feed ??= new NotificationFeed();
  return feed;
}
export function setNotificationFeed(f: NotificationFeed | null): void { feed = f; }
