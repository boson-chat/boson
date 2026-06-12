// Deterministic per-nick color — the "auto-coloring" most IRC clients do.
// Hash the case-folded nick to a hue and pin saturation/lightness to values
// tuned for the dark theme, so every nick gets a stable, distinguishable,
// legible color (same nick → same color across sessions and servers).
export function nickColor(nick: string): string {
  const key = nick.trim().toLowerCase();
  let h = 0;
  for (let i = 0; i < key.length; i++) {
    // djb2-ish; >>> 0 keeps it an unsigned 32-bit int.
    h = (h * 31 + key.charCodeAt(i)) >>> 0;
  }
  return `hsl(${h % 360} 62% 64%)`;
}

// Avatar glyph for a nick: its first alphanumeric character, uppercased.
// Strips any leading IRC status sigil (~&@%+) so "@alice" → "A".
export function nickInitial(nick: string): string {
  const m = nick.trim().replace(/^[~&@%+]+/, '').match(/[a-z0-9]/i);
  return (m?.[0] ?? '?').toUpperCase();
}
