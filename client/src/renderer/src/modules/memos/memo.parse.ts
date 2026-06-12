// Parsers for MemoServ output, built from REAL captured fixtures of both
// dominant services packages (see memo.parse.test.ts for the verbatim
// captures driving these):
//
//   Anope (boson.chat)            Atheme (Libera)
//   ─────────────────────────     ───────────────────────────────────────
//   on-login:  "You have 2 new memos."   (both identical; Atheme adds a
//                                          "To read them, type …" line)
//
//   LIST row:  "* 1     alice  Jun…UTC (14 seconds ago)"
//              ("* " prefix ⇒ unread, plain spaces ⇒ read)
//              "- 1 From: alice Sent: Jun 12 11:58:12 2026 +0000 [unread]"
//              ("[unread]" suffix ⇒ unread)
//
//   READ hdr:  "Memo 1 from alice (Jun 12 … ago))."
//              "Memo 1 - Sent by alice, Jun 12 11:58:12 2026 +0000"
//
// The parsers try both shapes so the same code serves either network
// without first having to resolve the framework. Anything that doesn't
// match a known shape returns null and the caller treats it as chrome
// (column headers, separators, the "To delete…" hint) to ignore.

export interface MemoListEntry {
  // 1-based index MemoServ assigns; the argument to `READ <n>` / `DEL <n>`.
  // NOT stable across deletions, so callers key dedup on sender+date.
  index: number;
  // Account nick that sent the memo.
  sender: string;
  // Verbatim date/time string from the service (format differs per
  // package; we display it as-is and don't attempt to parse to epoch).
  date: string;
  // Server-side unread flag (Anope "* ", Atheme "[unread]").
  unread: boolean;
}

export interface MemoReadHeader {
  index: number;
  sender: string;
  date: string;
}

// "You have 2 new memos." / "You have 1 new memo." → the count.
// Identical on Anope + Atheme. This is the trigger to auto-issue LIST.
// Returns null for everything else.
export function parseNewMemoCount(body: string): number | null {
  const m = /\byou have (\d+) new memos?\b/i.exec(body);
  return m ? Number(m[1]) : null;
}

// "You have no memos." — both packages. Lets the caller clear any stale
// inbox entries for this server.
export function isNoMemos(body: string): boolean {
  return /\byou have no memos\b/i.test(body);
}

// Atheme LIST row:  "- 1 From: alice Sent: Jun 12 11:58:12 2026 +0000 [unread]"
const ATHEME_ROW = /^-\s*(\d+)\s+From:\s*(\S+)\s+Sent:\s*(.+?)\s*(\[unread\])?\s*$/i;
// Anope LIST row:   "* 1     alice  Jun 12 11:47:24 2026 UTC (14 seconds ago)"
//                   "  1     alice  Jun 12 11:47:24 2026 UTC (20 seconds ago)"
const ANOPE_ROW = /^(\*?)\s*(\d+)\s+(\S+)\s+(.+?)\s*$/;

// Parse a single LIST output line into a memo entry, or null if the line
// is list chrome (header / column titles / blank) we should skip.
export function parseListEntry(line: string): MemoListEntry | null {
  // Atheme first — its shape is more specific ("From:"/"Sent:"), so it
  // can't be mistaken for an Anope row, but an Anope row (loose) could
  // swallow an Atheme one.
  const a = ATHEME_ROW.exec(line);
  if (a) {
    return { index: Number(a[1]), sender: a[2]!, date: a[3]!.trim(), unread: Boolean(a[4]) };
  }
  // Anope: reject the column-header ("Number  Sender  Date/Time") and the
  // "Memos for X:" banner — neither begins with an optional "*" + digits.
  const n = ANOPE_ROW.exec(line);
  if (n) {
    return { index: Number(n[2]), sender: n[3]!, date: n[4]!.trim(), unread: n[1] === '*' };
  }
  return null;
}

// Anope READ header: "Memo 1 from alice (Jun 12 11:47:24 2026 UTC (17 seconds ago))."
const ANOPE_READ_HEADER = /^Memo (\d+) from (\S+) \((.+)\)\.\s*$/;
// Atheme READ header:  "Memo 1 - Sent by alice, Jun 12 11:58:12 2026 +0000"
const ATHEME_READ_HEADER = /^Memo (\d+) - Sent by (\S+?),\s*(.+?)\s*$/;

// Parse the first line of a READ <n> reply. Returns the memo coordinates
// so the caller can attach the following body line(s) to the right entry.
export function parseReadHeader(line: string): MemoReadHeader | null {
  const a = ANOPE_READ_HEADER.exec(line);
  if (a) return { index: Number(a[1]), sender: a[2]!, date: a[3]! };
  const t = ATHEME_READ_HEADER.exec(line);
  if (t) return { index: Number(t[1]), sender: t[2]!, date: t[3]!.trim() };
  return null;
}

// Lines inside a READ reply that are NOT body: Anope's "To delete, type:
// /msg MemoServ DEL 1" hint and Atheme's "------" separator rule. Also
// treats a blank/whitespace-only line as skippable chrome.
export function isReadChrome(line: string): boolean {
  if (line.trim() === '') return true;
  if (/^to delete, type:/i.test(line.trim())) return true;
  if (/^-{4,}\s*$/.test(line.trim())) return true;
  return false;
}
