// Threads, Slack-style, from reply chains.
//
// A reply (ChatMessage.replyTo, a msgid; or replyToId, a local id) answers
// one message; a reply to a reply stays in the same thread. A thread's root
// is the top of its chain: follow the links up until a message that isn't
// a (linked) reply. Guessed replies (replyGuess: the text only said `nick:`)
// never join a thread; they stay single quoted replies.
//
// When what a chain answers isn't loaded (older than the scrollback, or the
// server never had it), the oldest message of the chain that is loaded
// roots the thread; once the real root arrives (older history prepended,
// an original fetched into the list) the thread moves under it.
//
// Nothing here is stored: it's all derived from the conversation's
// messages. ThreadIndex keeps it incrementally (sync() with each new copy of
// the list: lines appended, a page prepended, a line replaced), so a render
// only reads it.

import type { ChatMessage } from './chat.types';

/** What the main timeline shows under a thread's root. */
export interface ThreadSummary {
  rootId: string;
  /** Replies in the thread (the root not counted). */
  count: number;
  /** The newest reply. */
  lastAt: number;
  lastId: string;
  /** Who replied, newest first, each once (at most SUMMARY_NICKS). */
  nicks: string[];
}

export const SUMMARY_NICKS = 3;

/** Called when a message starts or stops having a thread under it. */
export type ThreadToggle = (rootId: string, has: boolean) => void;

// A reply's links: by local id, by msgid. A guess has none.
function refsOf(m: ChatMessage): string[] {
  if (m.replyGuess) return [];
  const out: string[] = [];
  if (m.replyToId && m.replyToId !== m.id) out.push(`i:${m.replyToId}`);
  if (m.replyTo && m.replyTo !== m.msgid) out.push(`m:${m.replyTo}`);
  return out;
}

function sameLinks(a: ChatMessage, b: ChatMessage): boolean {
  return a.msgid === b.msgid && a.replyTo === b.replyTo && a.replyToId === b.replyToId && a.replyGuess === b.replyGuess;
}

export class ThreadIndex {
  private readonly msgs = new Map<string, ChatMessage>();
  private readonly byMsgid = new Map<string, string>();
  // Linked replies: child → parent, parent → direct children.
  private readonly parent = new Map<string, string>();
  private readonly children = new Map<string, Set<string>>();
  // Replies whose original isn't here (yet), by link (`i:id` / `m:msgid`).
  private readonly waiting = new Map<string, Set<string>>();
  // Every linked reply's root, and each root's replies.
  private readonly rootOfId = new Map<string, string>();
  private readonly replies = new Map<string, Set<string>>();
  private readonly summaries = new Map<string, ThreadSummary>();
  private seen: readonly ChatMessage[] = [];
  /** Bumped whenever a thread changes. */
  version = 0;

  constructor(private readonly onToggle?: ThreadToggle) {}

  /**
   * Bring the index up to `list` (the conversation, oldest first). Cheap
   * when it's the same list, or the last one with lines added at either
   * end or replaced in place; anything else is diffed by id.
   */
  sync(list: readonly ChatMessage[]): void {
    const old = this.seen;
    if (list === old) return;
    this.seen = list;
    const k = old.length > 0 && list.length >= old.length ? this.alignment(old, list) : -1;
    if (k >= 0) {
      for (let i = 0; i < old.length; i++) {
        const n = list[k + i]!;
        if (n !== old[i]) this.update(n);
      }
      for (let i = k - 1; i >= 0; i--) this.add(list[i]!);
      for (let i = k + old.length; i < list.length; i++) this.add(list[i]!);
    } else {
      const ids = new Set<string>();
      for (const m of list) ids.add(m.id);
      for (const id of Array.from(this.msgs.keys())) if (!ids.has(id)) this.remove(id);
      for (const m of list) {
        if (this.msgs.has(m.id)) this.update(m);
        else this.add(m);
      }
    }
  }

  // Where `old` sits inside `list` (lines added before and / or after it,
  // the same ids in the same order), or -1.
  private alignment(old: readonly ChatMessage[], list: readonly ChatMessage[]): number {
    const first = old[0]!.id;
    const last = old[old.length - 1]!.id;
    for (let k = 0; k + old.length <= list.length; k++) {
      if (list[k]!.id !== first || list[k + old.length - 1]!.id !== last) continue;
      for (let i = 1; i < old.length - 1; i++) if (list[k + i]!.id !== old[i]!.id) return -1;
      return k;
    }
    return -1;
  }

  /** The root of the thread `id` is in (itself when it's no reply). */
  rootOf(id: string): string {
    return this.rootOfId.get(id) ?? id;
  }

  /** The thread `id` belongs to, as root or reply; undefined when none. */
  threadOf(id: string): string | undefined {
    const r = this.rootOf(id);
    return this.replies.get(r)?.size ? r : undefined;
  }

  /** The summary under a root, the same object until its thread changes. */
  summary(rootId: string): ThreadSummary | undefined {
    const set = this.replies.get(rootId);
    if (!set || set.size === 0) return undefined;
    const have = this.summaries.get(rootId);
    if (have) return have;
    const list = this.sorted(set);
    const last = list[list.length - 1]!;
    const nicks: string[] = [];
    for (let i = list.length - 1; i >= 0 && nicks.length < SUMMARY_NICKS; i--) {
      const n = list[i]!.from;
      if (n && !nicks.some((x) => x.toLowerCase() === n.toLowerCase())) nicks.push(n);
    }
    const s: ThreadSummary = { rootId, count: list.length, lastAt: last.timestamp, lastId: last.id, nicks };
    this.summaries.set(rootId, s);
    return s;
  }

  /** A thread's messages, the root first, then the replies by time. */
  messages(rootId: string): ChatMessage[] {
    const root = this.msgs.get(rootId);
    if (!root) return [];
    const set = this.replies.get(rootId);
    return set ? [root, ...this.sorted(set)] : [root];
  }

  /** The message a reply links to here (not for a guess). */
  parentOf(id: string): string | undefined {
    return this.parent.get(id);
  }

  get(id: string): ChatMessage | undefined {
    return this.msgs.get(id);
  }

  byMsgidOf(msgid: string): ChatMessage | undefined {
    const id = this.byMsgid.get(msgid);
    return id ? this.msgs.get(id) : undefined;
  }

  // By time; the order they were added in for the same time.
  private sorted(ids: Set<string>): ChatMessage[] {
    const out: ChatMessage[] = [];
    for (const id of ids) { const m = this.msgs.get(id); if (m) out.push(m); }
    return out.sort((a, b) => a.timestamp - b.timestamp);
  }

  private resolve(ref: string): string | undefined {
    const v = ref.slice(2);
    if (ref.startsWith('i:')) return this.msgs.has(v) ? v : undefined;
    return this.byMsgid.get(v);
  }

  private add(m: ChatMessage): void {
    this.msgs.set(m.id, m);
    if (m.msgid && !this.byMsgid.has(m.msgid)) this.byMsgid.set(m.msgid, m.id);
    // Its own original, or wait for it.
    const refs = refsOf(m);
    let linked = false;
    for (const r of refs) {
      const p = this.resolve(r);
      if (p !== undefined && this.link(m.id, p)) { linked = true; break; }
    }
    if (!linked) for (const r of refs) this.wait(r, m.id);
    // Replies that were waiting for it.
    for (const r of [`i:${m.id}`, ...(m.msgid ? [`m:${m.msgid}`] : [])]) {
      const w = this.waiting.get(r);
      if (!w) continue;
      for (const c of Array.from(w)) if (!this.parent.has(c)) this.link(c, m.id);
    }
  }

  private update(m: ChatMessage): void {
    const have = this.msgs.get(m.id);
    if (!have) { this.add(m); return; }
    if (have === m) return;
    if (sameLinks(have, m)) {
      this.msgs.set(m.id, m);
      this.dirty(this.rootOf(m.id));
      return;
    }
    // Its links changed (an echo gave it a msgid): take it out and back in.
    this.remove(m.id);
    this.add(m);
  }

  private wait(ref: string, id: string): void {
    let w = this.waiting.get(ref);
    if (!w) { w = new Set(); this.waiting.set(ref, w); }
    w.add(id);
  }

  private unwait(m: ChatMessage): void {
    for (const r of refsOf(m)) {
      const w = this.waiting.get(r);
      if (!w) continue;
      w.delete(m.id);
      if (w.size === 0) this.waiting.delete(r);
    }
  }

  // Link reply `c` under `p`: `c` and its thread join p's. Refused when it
  // would close a loop (a chain that answers itself).
  private link(c: string, p: string): boolean {
    if (c === p) return false;
    for (let x: string | undefined = p, n = 0; x !== undefined; x = this.parent.get(x), n++) {
      if (x === c || n > 10_000) return false;
    }
    const cm = this.msgs.get(c);
    if (cm) this.unwait(cm);
    this.parent.set(c, p);
    let kids = this.children.get(p);
    if (!kids) { kids = new Set(); this.children.set(p, kids); }
    kids.add(c);
    const root = this.rootOf(p);
    const moving = [c, ...(this.replies.get(c) ?? [])];
    this.setReplies(c, null);
    const set = this.replies.get(root) ?? new Set<string>();
    for (const x of moving) { this.rootOfId.set(x, root); set.add(x); }
    this.setReplies(root, set);
    return true;
  }

  private remove(id: string): void {
    const m = this.msgs.get(id);
    if (!m) return;
    const p = this.parent.get(id);
    const root = this.rootOf(id);
    if (p !== undefined) {
      // Out of its thread, with everything under it.
      const set = this.replies.get(root);
      for (const x of this.subtree(id)) { set?.delete(x); this.rootOfId.delete(x); }
      this.setReplies(root, set && set.size ? set : null);
      this.children.get(p)?.delete(id);
      this.parent.delete(id);
    } else {
      for (const x of this.subtree(id)) this.rootOfId.delete(x);
      this.setReplies(id, null);
      this.unwait(m);
    }
    // Its replies root their own threads now, and wait for it to return.
    for (const c of Array.from(this.children.get(id) ?? [])) {
      this.parent.delete(c);
      const under = this.subtree(c).filter((x) => x !== c);
      for (const x of under) this.rootOfId.set(x, c);
      this.rootOfId.delete(c);
      this.setReplies(c, under.length ? new Set(under) : null);
      const cm = this.msgs.get(c);
      if (cm) for (const r of refsOf(cm)) this.wait(r, c);
    }
    this.children.delete(id);
    this.msgs.delete(id);
    if (m.msgid && this.byMsgid.get(m.msgid) === id) this.byMsgid.delete(m.msgid);
    this.summaries.delete(id);
  }

  // `id` and every reply under it.
  private subtree(id: string): string[] {
    const out = [id];
    for (let i = 0; i < out.length; i++) {
      for (const c of this.children.get(out[i]!) ?? []) out.push(c);
    }
    return out;
  }

  private setReplies(root: string, set: Set<string> | null): void {
    const had = (this.replies.get(root)?.size ?? 0) > 0;
    if (set && set.size > 0) this.replies.set(root, set);
    else this.replies.delete(root);
    const has = !!set && set.size > 0;
    this.dirty(root);
    if (had !== has) this.onToggle?.(root, has);
  }

  private dirty(root: string): void {
    this.summaries.delete(root);
    this.version++;
  }
}

// One index per conversation, kept with its message list (the signal, or
// whatever object stands for the conversation).
const indexes = new WeakMap<object, ThreadIndex>();
let toggleHook: ThreadToggle | undefined;

/** The thread index for a conversation (keyed by its message signal). */
export function threadIndexFor(key: object): ThreadIndex {
  let ix = indexes.get(key);
  if (!ix) {
    ix = new ThreadIndex((root, has) => toggleHook?.(root, has));
    indexes.set(key, ix);
  }
  return ix;
}

/** The message list's row heights follow threads appearing and going. */
export function setThreadToggleHook(fn: ThreadToggle | undefined): void {
  toggleHook = fn;
}

/**
 * The message a reply sent in a thread answers by default: the newest one
 * there from someone else, else the newest.
 */
export function threadReplyTarget(thread: readonly ChatMessage[], myNick: string): ChatMessage | undefined {
  const me = myNick.toLowerCase();
  const usable = (m: ChatMessage): boolean => !m.pending && (m.kind === 'message' || m.kind === 'action' || m.kind === 'notice');
  for (let i = thread.length - 1; i >= 0; i--) {
    const m = thread[i]!;
    if (usable(m) && m.from.toLowerCase() !== me) return m;
  }
  for (let i = thread.length - 1; i >= 0; i--) if (usable(thread[i]!)) return thread[i];
  return undefined;
}
