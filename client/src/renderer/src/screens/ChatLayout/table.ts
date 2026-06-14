// Parse pasted monospace tables — box-drawing (┌─┬─┐ │ ├─┼─┤), ASCII (+--+ |),
// or markdown pipe tables — into structured rows so the renderer can show real
// <table>s instead of a raw <pre>. A single block may hold MORE THAN ONE table
// (two pasted back-to-back), so parsing returns a list and splits on table
// boundaries (a bottom border immediately followed by a top border, a blank
// line, or a fresh markdown header). Returns null when the block isn't a clean
// set of tables (the caller then falls back to monospace rendering). Pure.

export interface ParsedTable {
  headers: string[];
  rows: string[][];
}

// Column separators: box single/heavy/double verticals + the ascii pipe.
const COL_SEP = /[│┃║|]/u;

// A pure border/rule line (no cell text): box-drawing horizontals/junctions, or
// an ascii rule of +-= — and never any alphanumerics.
function isBorderLine(s: string): boolean {
  const t = s.trim();
  if (!t || /[A-Za-z0-9]/.test(t)) return false;
  if (/^[\s─-╿]+$/u.test(t) && /[─-╿]/u.test(t)) return true; // box-drawing block U+2500–U+257F
  if (/^[\s+\-=]+$/.test(t) && /[-=]/.test(t)) return true;   // ascii rule +---+===+
  return false;
}

// Split a content row on its column separators and trim; drop the empty cells
// produced by leading/trailing border bars (│ a │ b │ → ['a','b']).
function splitRow(s: string): string[] {
  const parts = s.split(COL_SEP).map((c) => c.trim());
  while (parts.length && parts[0] === '') parts.shift();
  while (parts.length && parts[parts.length - 1] === '') parts.pop();
  return parts;
}

// A markdown/divider row whose cells are only dashes/colons (|---|:--:|).
function isDividerCells(cells: string[]): boolean {
  return cells.length > 0 && cells.every((c) => c === '' || /^:?-{2,}:?$/.test(c));
}

function finalize(rows: string[][]): ParsedTable | null {
  if (rows.length < 2) return null; // need a header + at least one body row
  const cols = Math.max(...rows.map((r) => r.length));
  if (cols < 2) return null;
  const norm = rows.map((r) => {
    const c = r.slice(0, cols);
    while (c.length < cols) c.push('');
    return c;
  });
  return { headers: norm[0]!, rows: norm.slice(1) };
}

// Parse one or more tables from a monospace block.
export function parseTables(text: string): ParsedTable[] | null {
  const lines = text.split('\n');
  const tables: ParsedTable[] = [];
  let rows: string[][] = [];
  let prevBorder = false;
  const flush = (): void => { const t = finalize(rows); if (t) tables.push(t); rows = []; };

  for (const line of lines) {
    if (!line.trim()) { flush(); prevBorder = false; continue; }
    if (isBorderLine(line)) {
      // Two borders back-to-back = end of one table, start of the next.
      if (prevBorder && rows.length) flush();
      prevBorder = true;
      continue;
    }
    prevBorder = false;
    if (!COL_SEP.test(line)) return null; // non-table content → whole block isn't tables
    const cells = splitRow(line);
    if (cells.length < 2) return null;
    if (isDividerCells(cells)) {
      // A divider after a complete table means the row just before it is the
      // next table's header (markdown tables pasted with no blank line).
      if (rows.length >= 2) { const h = rows.pop()!; flush(); rows.push(h); }
      continue;
    }
    rows.push(cells);
  }
  flush();
  return tables.length ? tables : null;
}

// Convenience: parse a block expected to hold exactly one table (else null).
export function parseTable(text: string): ParsedTable | null {
  const ts = parseTables(text);
  return ts && ts.length === 1 ? ts[0]! : null;
}
