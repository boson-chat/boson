// search-match.ts — what the full-page conversation search finds, and how a
// result is shown: matching (case-insensitive substring of the plain text),
// the filters (From a nick, Has link), the snippet with the match marked,
// and grouping by day. Pure functions; the query never leaves the device.
import type { ChatMessage } from '../chat/chat.types';
import { lineIdentity } from '../history/older-store';
import { stripIrcFormatting } from '../../screens/ChatLayout/markdown';

export interface SearchFilters {
  /** The text to find (any case). */
  text: string;
  /** Only lines from this nick (any case); null: anyone. */
  from: string | null;
  /** Only lines with a link in them. */
  hasLink: boolean;
}

export const EMPTY_FILTERS: SearchFilters = { text: '', from: null, hasLink: false };

// What people said (PRIVMSG, /me): not notices, joins, parts or system lines.
const SEARCHABLE: ReadonlySet<ChatMessage['kind']> = new Set(['message', 'action']);

const LINK_RE = /\b(?:https?:\/\/|www\.)[^\s<>"']+/i;

export function isSearchable(m: ChatMessage): boolean {
  return SEARCHABLE.has(m.kind);
}

/** The line's text as shown: IRC colour / bold codes removed. */
export function plainText(m: ChatMessage): string {
  return stripIrcFormatting(m.text);
}

export function hasLink(text: string): boolean {
  return LINK_RE.test(text);
}

/** Whether the filters ask for anything (an empty search shows nothing). */
export function isActive(f: SearchFilters): boolean {
  return f.text.trim().length > 0 || f.from !== null || f.hasLink;
}

export function matches(m: ChatMessage, f: SearchFilters): boolean {
  if (!isSearchable(m)) return false;
  if (f.from !== null && m.from.toLowerCase() !== f.from.toLowerCase()) return false;
  const text = plainText(m);
  if (f.hasLink && !hasLink(text)) return false;
  const needle = f.text.trim().toLowerCase();
  return !needle || text.toLowerCase().includes(needle);
}

/**
 * One list of everything searchable, oldest first, without the copies a
 * line has in both places (by msgid, else time + sender + text).
 */
export function mergeLines(...sources: ReadonlyArray<readonly ChatMessage[]>): ChatMessage[] {
  const seen = new Set<string>();
  const out: ChatMessage[] = [];
  for (const src of sources) {
    for (const m of src) {
      const id = lineIdentity(m);
      if (seen.has(id)) continue;
      seen.add(id);
      out.push(m);
    }
  }
  return out.sort((a, b) => a.timestamp - b.timestamp);
}

/** The matching lines, newest first. */
export function search(lines: readonly ChatMessage[], f: SearchFilters): ChatMessage[] {
  if (!isActive(f)) return [];
  const out: ChatMessage[] = [];
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = lines[i]!;
    if (matches(m, f)) out.push(m);
  }
  return out;
}

/** The nicks that said something in `lines`, for the From picker. */
export function authorsOf(lines: readonly ChatMessage[]): string[] {
  const seen = new Map<string, string>();
  for (const m of lines) if (isSearchable(m) && m.from && !seen.has(m.from.toLowerCase())) seen.set(m.from.toLowerCase(), m.from);
  return [...seen.values()];
}

export interface TextPart {
  text: string;
  match: boolean;
}

/**
 * `text` cut into plain and matched parts (every occurrence of `needle`, any
 * case). When the first match is far in, the start is dropped (with "…") so
 * it shows in a two-line snippet.
 */
export function highlightParts(text: string, needle: string, lead = 60): TextPart[] {
  const n = needle.trim().toLowerCase();
  if (!n) return [{ text, match: false }];
  const lower = text.toLowerCase();
  const first = lower.indexOf(n);
  if (first < 0) return [{ text, match: false }];
  let start = 0;
  let prefix = '';
  if (lead >= 0 && first > lead) {
    // Start at a word boundary a little before the match.
    const from = first - Math.floor(lead / 2);
    const space = text.lastIndexOf(' ', from);
    start = space > 0 && first - space < lead ? space + 1 : from;
    prefix = '…';
  }
  const parts: TextPart[] = [];
  let at = start;
  for (let i = lower.indexOf(n, at); i >= 0; i = lower.indexOf(n, at)) {
    if (i > at) parts.push({ text: text.slice(at, i), match: false });
    parts.push({ text: text.slice(i, i + n.length), match: true });
    at = i + n.length;
  }
  if (at < text.length) parts.push({ text: text.slice(at), match: false });
  if (prefix) {
    if (parts[0] && !parts[0].match) parts[0] = { text: prefix + parts[0].text, match: false };
    else parts.unshift({ text: prefix, match: false });
  }
  return parts;
}

/** Local calendar day, as a sortable key. */
export function dayKey(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

/** "Today", "Yesterday", "Nov 12" (with the year when it isn't this one). */
export function dayLabel(ts: number, now = Date.now()): string {
  const key = dayKey(ts);
  if (key === dayKey(now)) return 'Today';
  const y = new Date(now);
  y.setDate(y.getDate() - 1);
  if (key === dayKey(y.getTime())) return 'Yesterday';
  return shortDate(ts, now);
}

/** "Nov 12", or "Nov 12, 2025" outside this year. */
export function shortDate(ts: number, now = Date.now()): string {
  const d = new Date(ts);
  const sameYear = d.getFullYear() === new Date(now).getFullYear();
  return d.toLocaleDateString('en-US', sameYear ? { month: 'short', day: 'numeric' } : { month: 'short', day: 'numeric', year: 'numeric' });
}

export function timeLabel(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export interface DayGroup {
  key: string;
  label: string;
  items: ChatMessage[];
}

/** Results (newest first) under their day. */
export function groupByDay(results: readonly ChatMessage[], now = Date.now()): DayGroup[] {
  const groups: DayGroup[] = [];
  for (const m of results) {
    const key = dayKey(m.timestamp);
    const last = groups[groups.length - 1];
    if (last && last.key === key) last.items.push(m);
    else groups.push({ key, label: dayLabel(m.timestamp, now), items: [m] });
  }
  return groups;
}

/** A line and up to `n` lines either side of it in `lines` (oldest first), people's lines only. */
export function contextOf(lines: readonly ChatMessage[], target: ChatMessage, n = 3): { before: ChatMessage[]; after: ChatMessage[] } {
  const said = lines.filter((m) => isSearchable(m) || m.kind === 'notice');
  const i = said.indexOf(target);
  if (i < 0) return { before: [], after: [] };
  return { before: said.slice(Math.max(0, i - n), i), after: said.slice(i + 1, i + 1 + n) };
}
