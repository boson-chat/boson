// Text helpers shared by the dialect parsers.
import type { ChanServError, ChanServErrorCode, ChanServResult, Verdict } from './chanserv.types';

// IRC formatting: bold, colour (with its digits), reset, monospace, reverse,
// italic, strikethrough, underline. Services wrap names in bold; strip it all
// before matching.
const FORMAT_RX = /\x03(?:\d{1,2}(?:,\d{1,2})?)?|[\x02\x0f\x11\x16\x1d\x1e\x1f]/g;
export function plain(s: string): string {
  return s.replace(FORMAT_RX, '');
}

// Case-insensitive channel/account comparison (ASCII casemapping, which is
// what Ergo, Anope and Atheme use for names by default; rfc1459's []\~ folding
// only matters for names nobody types).
export function sameName(a: string | undefined, b: string | undefined): boolean {
  return !!a && !!b && a.toLowerCase() === b.toLowerCase();
}

// Escape a string for use inside a RegExp.
export function rxEscape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// An error-reply table: the first rule whose pattern matches any collected
// line wins.
export type ErrorRule = readonly [RegExp, ChanServErrorCode];

export function matchError(lines: readonly string[], rules: readonly ErrorRule[]): ChanServError | null {
  for (const line of lines) {
    const p = plain(line);
    for (const [rx, code] of rules) if (rx.test(p)) return { kind: 'error', code, lines: [...lines] };
  }
  return null;
}

export function anyLine(lines: readonly string[], rx: RegExp): RegExpMatchArray | null {
  for (const line of lines) {
    const m = plain(line).match(rx);
    if (m) return m;
  }
  return null;
}

export const unreadable = (lines: readonly string[]): ChanServError => ({ kind: 'error', code: 'unreadable', lines: [...lines] });
export const err = (code: ChanServErrorCode, lines: readonly string[]): ChanServError => ({ kind: 'error', code, lines: [...lines] });
export const done = (lines: readonly string[], extra: { pending?: boolean; nochange?: boolean } = {}): ChanServResult =>
  ({ kind: 'done', lines: [...lines], ...extra });

// The common shape of a one-shot action: success patterns, error patterns,
// and "unreadable" when the service went quiet without saying either.
export function simpleStep(
  lines: readonly string[],
  settled: boolean,
  ok: readonly RegExp[],
  errors: readonly ErrorRule[],
  nochange: readonly RegExp[] = [],
): Verdict<ChanServResult> {
  for (const rx of ok) if (anyLine(lines, rx)) return { final: done(lines) };
  for (const rx of nochange) if (anyLine(lines, rx)) return { final: done(lines, { nochange: true }) };
  const e = matchError(lines, errors);
  if (e) return { final: e };
  return settled ? { final: unreadable(lines) } : null;
}
