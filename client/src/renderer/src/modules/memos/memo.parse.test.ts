import { describe, it, expect } from 'vitest';
import {
  parseNewMemoCount,
  isNoMemos,
  parseListEntry,
  parseReadHeader,
  isReadChrome,
} from './memo.parse';

// Fixtures below are VERBATIM captures from the e2e docker stacks
// (Anope on UnrealIRCd, Atheme on InspIRCd) — register two accounts,
// send two memos, then LIST / READ as the recipient. Keeping the raw
// strings here pins the parser to real service output, not guesses.

describe('parseNewMemoCount (on-login trigger)', () => {
  it('matches the Anope/Atheme "You have N new memos." notice', () => {
    expect(parseNewMemoCount('You have 2 new memos.')).toBe(2);
    expect(parseNewMemoCount('You have 1 new memo.')).toBe(1);
  });
  it('does NOT match the LIST summary line "You have 2 memos (2 new)."', () => {
    // Atheme prints this as LIST chrome — it must not re-trigger a LIST.
    expect(parseNewMemoCount('You have 2 memos (2 new).')).toBeNull();
  });
  it('ignores unrelated notices', () => {
    expect(parseNewMemoCount('To read them, type /msg MemoServ READ NEW')).toBeNull();
    expect(parseNewMemoCount('The memo has been successfully sent to bob.')).toBeNull();
  });
});

describe('isNoMemos', () => {
  it('detects the empty-inbox reply', () => {
    expect(isNoMemos('You have no memos.')).toBe(true);
    expect(isNoMemos('You have 2 new memos.')).toBe(false);
  });
});

describe('parseListEntry — Anope rows', () => {
  it('parses an UNREAD row (leading "* ")', () => {
    const e = parseListEntry('* 1     alfeojj  Jun 12 11:47:24 2026 UTC (14 seconds ago)');
    expect(e).toMatchObject({ index: 1, sender: 'alfeojj', unread: true });
    expect(e!.date).toContain('Jun 12 11:47:24 2026 UTC');
  });
  it('parses a READ row (leading spaces, no "*")', () => {
    const e = parseListEntry('  1     alfeojj  Jun 12 11:47:24 2026 UTC (20 seconds ago)');
    expect(e).toMatchObject({ index: 1, sender: 'alfeojj', unread: false });
  });
  it('skips Anope LIST chrome (banner + column header)', () => {
    expect(parseListEntry('Memos for bofeojj:')).toBeNull();
    expect(parseListEntry('Number  Sender   Date/Time')).toBeNull();
  });
});

describe('parseListEntry — Atheme rows', () => {
  it('parses an UNREAD row ("[unread]" suffix)', () => {
    const e = parseListEntry('- 1 From: alhhmoj Sent: Jun 12 11:58:12 2026 +0000 [unread]');
    expect(e).toMatchObject({ index: 1, sender: 'alhhmoj', unread: true });
    expect(e!.date).toBe('Jun 12 11:58:12 2026 +0000');
  });
  it('parses a READ row (no "[unread]")', () => {
    const e = parseListEntry('- 2 From: alhhmoj Sent: Jun 12 11:58:16 2026 +0000');
    expect(e).toMatchObject({ index: 2, sender: 'alhhmoj', unread: false });
    expect(e!.date).toBe('Jun 12 11:58:16 2026 +0000');
  });
  it('skips Atheme LIST chrome (summary + blank line)', () => {
    expect(parseListEntry('You have 2 memos (2 new).')).toBeNull();
    expect(parseListEntry(' ')).toBeNull();
  });
});

describe('parseReadHeader', () => {
  it('parses the Anope READ header', () => {
    const h = parseReadHeader('Memo 1 from alfeojj (Jun 12 11:47:24 2026 UTC (17 seconds ago)).');
    expect(h).toMatchObject({ index: 1, sender: 'alfeojj' });
    expect(h!.date).toContain('Jun 12 11:47:24 2026 UTC');
  });
  it('parses the Atheme READ header', () => {
    const h = parseReadHeader('Memo 2 - Sent by alhhmoj, Jun 12 11:58:16 2026 +0000');
    expect(h).toMatchObject({ index: 2, sender: 'alhhmoj' });
    expect(h!.date).toBe('Jun 12 11:58:16 2026 +0000');
  });
  it('returns null for a body line', () => {
    expect(parseReadHeader('Are you around this week? Need to sync on the release.')).toBeNull();
  });
});

describe('isReadChrome', () => {
  it('skips the Anope delete hint', () => {
    expect(isReadChrome('To delete, type: /msg MemoServ DEL 1')).toBe(true);
  });
  it('skips the Atheme separator rule', () => {
    expect(isReadChrome('------------------------------------------')).toBe(true);
  });
  it('skips blank lines but keeps real body text', () => {
    expect(isReadChrome('   ')).toBe(true);
    expect(isReadChrome('Are you around this week? Need to sync on the release.')).toBe(false);
  });
});
