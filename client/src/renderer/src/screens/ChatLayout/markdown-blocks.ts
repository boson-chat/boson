// Multi-line markdown over IRC. A PRIVMSG carries one line, so a pasted
// document goes out as one message per line and arrives as a run of lines
// from the same sender, a second or two apart (the send queue paces them).
// This file holds the two pure halves of carrying it across: turning the
// composer's text into wire lines, and deciding whether a run of received
// lines is a document to render as one. The renderer is markdown-doc.ts.

import { BLANK_LINE } from '../../modules/chat';

// The composer's text as the lines to send. One line is trimmed as before.
// A multi-line paste keeps each line's indentation (code, nested lists) and
// its blank lines (runs collapsed to one, none at either end), and a line
// that starts with "/" is escaped as "//" so a path in a code block isn't run
// as a command.
export function toWireLines(text: string): string[] {
  const raw = text.split(/\r\n|\r|\n/).map((l) => l.replace(/\s+$/, ''));
  while (raw.length && !raw[0]) raw.shift();
  while (raw.length && !raw[raw.length - 1]) raw.pop();
  if (raw.length <= 1) {
    const one = (raw[0] ?? '').trim();
    return one ? [one] : [];
  }
  const out: string[] = [];
  for (const line of raw) {
    if (!line) {
      if (out[out.length - 1] !== BLANK_LINE) out.push(BLANK_LINE);
      continue;
    }
    out.push(line.replace(/^(\s*)\//, '$1//'));
  }
  return out;
}

// Lines from one sender at most this far apart belong to the same paste.
// Pastes are paced at one line per 1–2 s (send queue; ZNC's own flood
// control); people typing take longer between lines.
export const BURST_GAP_MS = 5_000;

const FENCE_RE = /^ {0,3}(```|~~~)/;
const HEADING_RE = /^ {0,3}#{1,6}\s+\S/;
const LIST_RE = /^\s*(?:[-*+]|\d{1,9}[.)])\s+\S/;
const QUOTE_RE = /^ {0,3}>(?:\s|$)/;
const TABLE_RULE_RE = /^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)+\|?\s*$/;
const MATH_RE = /^\s*\$\$/;

// Whether a run of lines from one sender reads as a markdown document — at
// least two lines, one of them block syntax that only means something across
// lines (a code fence, heading, list, quote, table or maths block). Lines of
// ordinary chat stay separate messages, and ASCII art (rules of ____ / ----)
// is left to the preformatted path.
export function isMarkdownDocument(lines: readonly string[]): boolean {
  return lines.filter((l) => l.trim()).length >= 2 && hasBlockMarkdown(lines);
}

export function hasBlockMarkdown(lines: readonly string[]): boolean {
  return lines.some((l) =>
    FENCE_RE.test(l) || HEADING_RE.test(l) || LIST_RE.test(l) ||
    QUOTE_RE.test(l) || TABLE_RULE_RE.test(l) || MATH_RE.test(l));
}
