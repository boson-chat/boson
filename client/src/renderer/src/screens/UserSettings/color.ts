// Colour maths for the theme editor's picker. The picker works in HSV
// (a saturation × brightness square plus a hue strip) with alpha, and writes
// back #rrggbb, or #rrggbbaa when not opaque, both of which theme files accept.

export interface Rgba { r: number; g: number; b: number; a: number } // 0-255, a 0-1
export interface Hsva { h: number; s: number; v: number; a: number } // h 0-360, s/v/a 0-1

const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n));
const hex2 = (n: number): string => Math.round(clamp(n, 0, 255)).toString(16).padStart(2, '0');

export function parseHex(value: string): Rgba | null {
  const m = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(value.trim());
  if (!m) return null;
  let h = m[1]!;
  if (h.length <= 4) h = [...h].map((c) => c + c).join('');
  const n = (i: number): number => parseInt(h.slice(i, i + 2), 16);
  return { r: n(0), g: n(2), b: n(4), a: h.length === 8 ? n(6) / 255 : 1 };
}

// Any CSS colour the browser understands → RGBA, by letting a canvas
// normalise it (it reports #rrggbb, or rgba() when translucent). null when
// it isn't a colour (or there's no canvas, as in tests: hex only then).
export function parseColor(value: string): Rgba | null {
  const hex = parseHex(value);
  if (hex) return hex;
  try {
    const ctx = document.createElement('canvas').getContext('2d');
    if (!ctx) return null;
    // A colour the canvas rejects leaves fillStyle alone; two sentinels
    // tell "rejected" apart from a colour that happens to equal one.
    ctx.fillStyle = '#000000';
    ctx.fillStyle = value;
    const a = String(ctx.fillStyle);
    ctx.fillStyle = '#ffffff';
    ctx.fillStyle = value;
    const b = String(ctx.fillStyle);
    if (a !== b) return null;
    const asHex = parseHex(a);
    if (asHex) return asHex;
    const m = /rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+))?\s*\)/.exec(a);
    if (m) return { r: +m[1]!, g: +m[2]!, b: +m[3]!, a: m[4] === undefined ? 1 : +m[4] };
  } catch { /* no canvas */ }
  return null;
}

export function formatHex({ r, g, b, a }: Rgba): string {
  const base = `#${hex2(r)}${hex2(g)}${hex2(b)}`;
  return a >= 1 ? base : `${base}${hex2(a * 255)}`;
}

export function rgbToHsv({ r, g, b, a }: Rgba): Hsva {
  const R = r / 255, G = g / 255, B = b / 255;
  const max = Math.max(R, G, B), min = Math.min(R, G, B), d = max - min;
  let h = 0;
  if (d > 0) {
    if (max === R) h = ((G - B) / d) % 6;
    else if (max === G) h = (B - R) / d + 2;
    else h = (R - G) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return { h, s: max === 0 ? 0 : d / max, v: max, a };
}

export function hsvToRgb({ h, s, v, a }: Hsva): Rgba {
  const c = v * s;
  const hh = (((h % 360) + 360) % 360) / 60;
  const x = c * (1 - Math.abs((hh % 2) - 1));
  const [r, g, b] =
    hh < 1 ? [c, x, 0] : hh < 2 ? [x, c, 0] : hh < 3 ? [0, c, x] :
    hh < 4 ? [0, x, c] : hh < 5 ? [x, 0, c] : [c, 0, x];
  const m = v - c;
  return { r: (r + m) * 255, g: (g + m) * 255, b: (b + m) * 255, a };
}

export const hsvToHex = (c: Hsva): string => formatHex(hsvToRgb(c));
export { clamp };
