// IRCv3 reactions (`+draft/react` / `+draft/unreact` client tags, sent on a
// TAGMSG with `+draft/reply=<msgid>` naming the message reacted to).
//
// Spec: https://ircv3.net/specs/client-tags/react (unreact merged in
// ircv3-specifications#568). The ratified unprefixed names (`+react`,
// `+unreact`) are read too, as with replies.
//
// Reactions are kept as a log per conversation: target msgid → one entry per
// (nick, emoji), holding whether it's on and when that was last said. The
// newest statement wins, so the same events applied in any order (live,
// then replayed by CHATHISTORY with event-playback, then live again after a
// reconnect) end in the same state, and a replay of old events can't undo a
// newer unreact. Entries for a message that isn't loaded yet just wait in
// the log: rendering looks reactions up by msgid, so they show once it
// arrives.

export const REACT_TAG = '+draft/react';
export const UNREACT_TAG = '+draft/unreact';
const REACT_TAGS = [REACT_TAG, '+react'] as const;
const UNREACT_TAGS = [UNREACT_TAG, '+unreact'] as const;

// A reaction longer than this (in UTF-16 units) is ignored: the value is
// unrestricted by the spec, and a chip is for an emoji or a short word.
export const MAX_REACTION_LENGTH = 32;

export interface ReactionEntry {
  nick: string;
  emoji: string;
  /** False once unreacted (kept, so an older replayed react can't revive it). */
  on: boolean;
  /** When this was said (epoch ms, our clock). */
  at: number;
  /** The TAGMSG's own msgid: a REDACT of it takes the reaction back. */
  id?: string;
}

/** Target msgid → its reaction entries. */
export type ReactionLog = ReadonlyMap<string, readonly ReactionEntry[]>;

export interface ReactionEvent {
  /** The msgid reacted to. */
  target: string;
  nick: string;
  emoji: string;
  on: boolean;
  at: number;
  id?: string;
}

// The reaction a TAGMSG's tags carry, or null when it carries none (typing,
// a reply-less react, an over-long value, react and unreact both set).
export function reactionOf(
  tags: Record<string, string> | undefined,
  replyTo: string | undefined,
): { emoji: string; on: boolean } | null {
  if (!tags || !replyTo) return null;
  const react = REACT_TAGS.map((t) => tags[t]).find(Boolean);
  const unreact = UNREACT_TAGS.map((t) => tags[t]).find(Boolean);
  if (react && unreact) return null; // MUST NOT both be set: ambiguous
  const emoji = (react ?? unreact)?.trim();
  if (!emoji || emoji.length > MAX_REACTION_LENGTH) return null;
  return { emoji, on: !!react };
}

const sameNick = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

// The entries after one event, or null when it changes nothing (an older
// or repeated statement).
export function applyReaction(entries: readonly ReactionEntry[] | undefined, ev: ReactionEvent): ReactionEntry[] | null {
  const list = entries ?? [];
  const at = list.findIndex((r) => r.emoji === ev.emoji && sameNick(r.nick, ev.nick));
  const next: ReactionEntry = { nick: ev.nick, emoji: ev.emoji, on: ev.on, at: ev.at, ...(ev.id ? { id: ev.id } : {}) };
  if (at < 0) {
    // An unreact for a reaction we never saw: remembered anyway, so the
    // react it undoes (replayed later, older) stays undone.
    return [...list, next];
  }
  const cur = list[at]!;
  if (ev.at < cur.at) return null;
  // The same statement again (a replay, or our own react and then its echo).
  if (cur.on === ev.on && ev.at === cur.at && (!ev.id || ev.id === cur.id)) return null;
  return list.map((r, i) => (i === at ? { ...next, ...(next.id || !cur.id ? {} : { id: cur.id }) } : r));
}

// Merge one set of entries into another (stored entries into the live log).
export function mergeReactions(a: readonly ReactionEntry[] | undefined, b: readonly ReactionEntry[]): ReactionEntry[] | null {
  let cur: ReactionEntry[] | null = null;
  for (const r of b) {
    const next = applyReaction(cur ?? a, { target: '', ...r });
    if (next) cur = next;
  }
  return cur;
}

// A REDACT of a reaction's own TAGMSG: that reaction, taken back.
export function redactReaction(entries: readonly ReactionEntry[], id: string): ReactionEntry[] | null {
  if (!entries.some((r) => r.id === id && r.on)) return null;
  return entries.map((r) => (r.id === id ? { ...r, on: false } : r));
}

export interface ReactionChip {
  emoji: string;
  count: number;
  /** Who reacted, in the order they did. */
  nicks: string[];
  /** We are one of them. */
  mine: boolean;
}

// The chips under a message: one per emoji that anyone still has on, in the
// order each emoji was first used.
export function reactionChips(entries: readonly ReactionEntry[] | undefined, myNick: string): ReactionChip[] {
  if (!entries) return [];
  const on = entries.filter((r) => r.on).sort((x, y) => x.at - y.at);
  const chips = new Map<string, ReactionChip>();
  for (const r of on) {
    let c = chips.get(r.emoji);
    if (!c) { c = { emoji: r.emoji, count: 0, nicks: [], mine: false }; chips.set(r.emoji, c); }
    c.count++;
    c.nicks.push(r.nick);
    if (myNick && sameNick(r.nick, myNick)) c.mine = true;
  }
  return Array.from(chips.values());
}

// "alice, bob and 3 others reacted with 👍".
export function whoReacted(chip: ReactionChip, myNick: string, max = 8): string {
  const names = chip.nicks.map((n) => (myNick && sameNick(n, myNick) ? 'You' : n));
  const shown = names.slice(0, max);
  const rest = names.length - shown.length;
  let list: string;
  if (rest > 0) list = `${shown.join(', ')} and ${rest} other${rest === 1 ? '' : 's'}`;
  else if (shown.length > 1) list = `${shown.slice(0, -1).join(', ')} and ${shown[shown.length - 1]}`;
  else list = shown[0] ?? '';
  return `${list} reacted with ${chip.emoji}`;
}
