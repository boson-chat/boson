// Tile layout and layer choice for the call view: the same rules as
// quicvideo's own clients (web/src/layers.ts, the Go viewer).
import type { VideoLayer } from './video.types';

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

// The most tiles shown at once (last-N): the rest are hidden and not
// received.
export const MAX_TILES = 9;

/** The largest layer worth receiving for a w×h (device pixel) tile, or null
 * to receive nothing (hidden, or no layers). */
export function layerForTile(layers: VideoLayer[], w: number, h: number, visible: boolean): number | null {
  if (!visible || w <= 0 || h <= 0 || layers.length === 0) return null;
  const sorted = [...layers].sort((a, b) => a.width * a.height - b.width * b.height);
  for (const l of sorted) {
    if (l.width <= 0 || l.height <= 0) continue;
    // A layer at most ~10% smaller than the tile is good enough.
    if (Math.min(w / l.width, h / l.height) <= 1 / 0.9) return l.id;
  }
  return sorted[sorted.length - 1].id;
}

/** A grid, or a pinned big tile plus a strip of the others. Keys beyond
 * MAX_TILES (or the strip's 6) get null: hidden. */
export function layout<K>(keys: K[], pinned: K | null, w: number, h: number): Map<K, Rect | null> {
  const gap = 6;
  const out = new Map<K, Rect | null>(keys.map((k) => [k, null]));
  if (keys.length === 0 || w <= 0 || h <= 0) return out;
  if (pinned !== null && keys.includes(pinned) && keys.length > 1) {
    const stripH = Math.max(90, h * 0.22);
    out.set(pinned, { x: gap, y: gap, w: w - 2 * gap, h: h - stripH - 3 * gap });
    const others = keys.filter((k) => k !== pinned).slice(0, 6);
    const tw = Math.min((w - gap * (others.length + 1)) / others.length, (stripH * 16) / 9);
    others.forEach((k, i) => out.set(k, { x: gap + i * (tw + gap), y: h - stripH - gap, w: tw, h: stripH }));
    return out;
  }
  const n = Math.min(keys.length, MAX_TILES);
  const cols = Math.ceil(Math.sqrt(n));
  const rows = Math.ceil(n / cols);
  const tw = (w - gap * (cols + 1)) / cols;
  const th = (h - gap * (rows + 1)) / rows;
  keys.slice(0, n).forEach((k, i) => {
    const r = Math.floor(i / cols);
    const c = i % cols;
    out.set(k, { x: gap + c * (tw + gap), y: gap + r * (th + gap), w: tw, h: th });
  });
  return out;
}
