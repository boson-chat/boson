// Replies that classic IRC clients can read too.
//
// Every reply Boson sends starts with a plain-text form of who it answers,
// so a client that knows nothing of IRCv3 replies still sees it:
//
//   bob: "anyone know..." it's libssl-dev  (an older line of bob's)
//   bob: "...libssl..." that one           (no short prefix tells it apart)
//
// The quote is the shortest run of the line's first words that none of
// bob's other recent lines in the conversation starts with (compared
// without case or punctuation), at most QUOTE_MAX characters; failing that,
// a word of it that none of the others has.
//
// On receive the quoted form is read back: a line from someone else without
// a reply tag that starts with `nick: "words..."` answers nick's newest
// earlier line starting with those words. A line that only starts with
// `nick:` is not treated as a reply (people address each other that way
// all the time; guessing made replies out of plain mentions).

import type { ChatMessage } from './chat.types';

/** The longest quote, in characters (without the quotes and dots). */
export const QUOTE_MAX = 25;
/** How far back the quote is made unique, and a text reply looks. */
export const REPLY_WINDOW = 200;

const NICK = String.raw`[A-Za-z_\[\]\\\`^{}|][A-Za-z0-9_\-\[\]\\\`^{}|]*`;
// `nick: ` at the start of a line (or just `nick:`).
const ADDRESS_RE = new RegExp(`^(${NICK}):(?:\\s+|$)`);
// The quote after it: `"words..."` or `"...word..."` (an ellipsis too).
const QUOTE_RE = /^"((?:\.\.\.|…)?)(.+?)(?:\.\.\.|…)"(?:\s+|$)/;
// IRC formatting codes (bold, colour, italics, …).
const FORMAT_RE = /\x03(?:\d{1,2}(?:,\d{1,2})?)?|\x04(?:[0-9a-fA-F]{6}(?:,[0-9a-fA-F]{6})?)?|[\x02\x0f\x11\x16\x1d\x1e\x1f]/g;

const SAID: ReadonlySet<ChatMessage['kind']> = new Set(['message', 'action', 'notice']);

export function sameNick(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/** A word as compared: lower case, letters and digits only. */
export function normWord(w: string): string {
  return w.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}

interface Words { raw: string[]; norm: string[] }

function wordsOf(text: string): Words {
  const raw: string[] = [];
  const norm: string[] = [];
  for (const w of text.replace(FORMAT_RE, '').split(/\s+/)) {
    const n = normWord(w);
    if (!n) continue;
    raw.push(w);
    norm.push(n);
  }
  return { raw, norm };
}

/**
 * What a line says, for quoting and matching: without formatting, a
 * leading `someone: ` and the quote of a reply.
 */
export function quotableText(text: string): string {
  let t = text.replace(FORMAT_RE, '').trim();
  const a = ADDRESS_RE.exec(t);
  if (a) {
    t = t.slice(a[0].length);
    const q = QUOTE_RE.exec(t);
    if (q) t = t.slice(q[0].length);
  }
  return t;
}

function startsWithWords(words: readonly string[], prefix: readonly string[], lastPartial = false): boolean {
  if (words.length < prefix.length) return false;
  for (let i = 0; i < prefix.length; i++) {
    const last = i === prefix.length - 1;
    if (last && lastPartial ? !words[i]!.startsWith(prefix[i]!) : words[i] !== prefix[i]) return false;
  }
  return true;
}

function containsWords(words: readonly string[], run: readonly string[]): boolean {
  if (run.length === 0) return false;
  return ` ${words.join(' ')} `.includes(` ${run.join(' ')} `);
}

// Quote text: no double quotes inside, no punctuation trailing.
function display(raw: readonly string[]): string {
  return raw.join(' ').replace(/"/g, '').replace(/[\s.,;:!?…'()[\]{}<>-]+$/u, '');
}

function saidBy(m: ChatMessage, nick: string): boolean {
  return SAID.has(m.kind) && sameNick(m.from, nick);
}

/**
 * The text a reply to `target` starts with: `nick: ` when it's their latest
 * line in `messages` (the conversation, oldest first), else
 * `nick: "quote..." `.
 */
export function replyPrefix(target: ChatMessage, messages: readonly ChatMessage[]): string {
  const nick = target.from;
  const theirs = messages.slice(-REPLY_WINDOW).filter((m) => saidBy(m, nick));
  const mine = wordsOf(quotableText(target.text));
  if (mine.norm.length === 0) return `${nick}: `;
  const others = theirs.filter((m) => m.id !== target.id).map((m) => wordsOf(quotableText(m.text)).norm);
  // The shortest run of first words nobody else's line starts with.
  for (let k = 1; k <= mine.norm.length; k++) {
    const q = display(mine.raw.slice(0, k));
    if (q.length > QUOTE_MAX) break;
    const prefix = mine.norm.slice(0, k);
    if (!others.some((o) => startsWithWords(o, prefix))) return `${nick}: "${q}..." `;
  }
  // A word of it none of the others has (the longest such).
  const seen = new Set(others.flat());
  let best = -1;
  mine.norm.forEach((w, i) => {
    if (seen.has(w) || w.length < 3 || display([mine.raw[i]!]).replace(/^[^\p{L}\p{N}]+/u, '').length > QUOTE_MAX) return;
    if (best < 0 || w.length > mine.norm[best]!.length) best = i;
  });
  if (best >= 0) return `${nick}: "...${display([mine.raw[best]!]).replace(/^[^\p{L}\p{N}]+/u, '')}..." `;
  // Nothing tells it apart (the same line said twice): its first words.
  let q = '';
  for (let k = 1; k <= mine.raw.length; k++) {
    const next = display(mine.raw.slice(0, k));
    if (next.length > QUOTE_MAX) break;
    q = next;
  }
  if (!q) q = display(mine.raw.slice(0, 1)).slice(0, QUOTE_MAX);
  return `${nick}: "${q}..." `;
}

/** Whether `text` already starts by addressing `nick` (`nick:` / `nick,`). */
export function addresses(text: string, nick: string): boolean {
  const t = text.trimStart();
  return t.length > nick.length && sameNick(t.slice(0, nick.length), nick) && /^[:,]/.test(t.slice(nick.length));
}

export interface TextReply {
  nick: string;
  /** The quote's words (normalised); `inner` for the `"...word..."` form. */
  quote?: { words: string[]; inner: boolean };
  /** Length of the `nick: "quote..." ` part at the start of the text. */
  prefixLength: number;
  /** Length of just `nick: `. */
  addressLength: number;
}

/** Read the reply form at the start of a line, if it has one. */
export function parseTextReply(text: string): TextReply | null {
  const a = ADDRESS_RE.exec(text);
  if (!a) return null;
  const rest = text.slice(a[0].length);
  const q = QUOTE_RE.exec(rest);
  const words = q ? wordsOf(q[2]!).norm : [];
  if (q && words.length > 0) {
    return { nick: a[1]!, quote: { words, inner: !!q[1] }, prefixLength: a[0].length + q[0].length, addressLength: a[0].length };
  }
  return { nick: a[1]!, prefixLength: a[0].length, addressLength: a[0].length };
}

export interface ReplyLink {
  /** The local id of the message answered. */
  id: string;
  /** Only `nick:`: their latest line, a guess. */
  guessed: boolean;
}

/**
 * The message a line answers by its text alone, among `before` (what came
 * before it in the conversation, oldest first). Only for a line from
 * someone else to someone who spoke earlier, without a reply tag.
 */
export function resolveTextReply(msg: ChatMessage, before: readonly ChatMessage[]): ReplyLink | null {
  if (msg.replyTo || msg.kind !== 'message') return null;
  const p = parseTextReply(msg.text);
  if (!p || !p.quote || sameNick(p.nick, msg.from)) return null;
  const start = Math.max(0, before.length - REPLY_WINDOW);
  let latest: ChatMessage | null = null;
  for (let i = before.length - 1; i >= start; i--) {
    const m = before[i]!;
    if (!saidBy(m, p.nick)) continue;
    latest ??= m;
    const words = wordsOf(quotableText(m.text)).norm;
    const hit = p.quote.inner ? containsWords(words, p.quote.words) : startsWithWords(words, p.quote.words, true);
    if (hit) return { id: m.id, guessed: false };
  }
  // A quote that matches nothing here: what it answers isn't loaded.
  return null;
}

/**
 * The text to show for a reply whose original is `parent`: without the
 * `nick: "quote..." ` it starts with (that's what the quote above it is
 * for). A guess keeps its text as written.
 */
export function replyBody(msg: ChatMessage, parent: ChatMessage | null | undefined): string {
  if (!parent || msg.replyGuess) return msg.text;
  return withoutReplyPrefix(msg.text, parent.from);
}

/** `text` without the reply form it starts with (to `nick`, when given). */
export function withoutReplyPrefix(text: string, nick?: string): string {
  const p = parseTextReply(text);
  if (!p || (nick !== undefined && !sameNick(p.nick, nick))) return text;
  const rest = text.slice(p.prefixLength);
  return rest.trim() ? rest : text;
}
