// Parse a pasted monospace table — box-drawing (┌─┬─┐ │ ├─┼─┤), ASCII (+--+ |),
// or markdown pipe tables — into structured rows so the renderer can show a real
// <table> instead of a raw <pre>. Returns null when the block isn't a clean
// table (the caller then falls back to monospace rendering). Pure + dep-free.

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
  // Box-drawing block U+2500–U+257F (incl. verticals → empty separator rows).
  if (/^[\s─-╿]+$/u.test(t) && /[─-╿]/u.test(t)) return true;
  // ASCII rule: +---+===+
  if (/^[\s+\-=]+$/.test(t) && /[-=]/.test(t)) return true;
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

export function parseTable(text: string): ParsedTable | null {
  const lines = text.split('\n');
  const rows: string[][] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    if (isBorderLine(line)) continue;
    if (!COL_SEP.test(line)) return null; // a non-table line → not a clean table
    const cells = splitRow(line);
    if (cells.length < 2) return null;
    if (isDividerCells(cells)) continue;
    rows.push(cells);
  }
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
