// Parser for ZNC's `*status ListNetworks` reply. ZNC renders the network
// list as a CTable — pipe-delimited rows with a header + separator rows, e.g.
//
//   | Network | OnIRC | IRC Server            | IRC User | Channels |
//   | libera  | Yes   | irc.libera.chat:+6697 | nyan     | 12       |
//   | oftc    | No    | (Not connected)       |          | 0        |
//
// We only care about column 0 (the network name), so the parser is tolerant
// of column reordering / renames across ZNC versions: keep pipe-rows, drop
// the header + separator rows, take the first cell.

// Cells made up only of table-drawing characters (separator rows like
// `+----+----+` or `|====|====|`).
const SEPARATOR_CELL = /^[-+=\s]*$/;

export function parseZncNetworks(lines: readonly string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of lines) {
    if (!raw.includes('|')) continue;
    // Split on the pipe and trim; drop the empty cells that border `| a | b |`.
    const cells = raw.split('|').map((c) => c.trim()).filter((c) => c.length > 0);
    if (cells.length === 0) continue;
    // Separator row (all cells are dashes/plus/equals).
    if (cells.every((c) => SEPARATOR_CELL.test(c))) continue;
    const name = cells[0]!;
    // Header row.
    if (name.toLowerCase() === 'network') continue;
    if (SEPARATOR_CELL.test(name)) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(name);
  }
  return out;
}
