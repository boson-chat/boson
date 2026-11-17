// Tile layout and layer choice for the call view: the same rules as
// quicvideo's own clients (web/src/layers.ts, the Go viewer).
import type { VideoLayer } from './video.types';

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

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

/** Where to draw a w×h picture in a cw×ch canvas: contain (letterboxed:
 * screens), or cover (cropped: cameras), cropping at most a third of
 * either side so a wildly different shape letterboxes a little instead of
 * becoming a sliver. */
export function fitRect(w: number, h: number, cw: number, ch: number, fit: 'cover' | 'contain'): Rect {
  const sMin = Math.min(cw / w, ch / h);
  const s = fit === 'contain' ? sMin : Math.min(Math.max(cw / w, ch / h), sMin * 1.5);
  const dw = w * s;
  const dh = h * s;
  return { x: (cw - dw) / 2, y: (ch - dh) / 2, w: dw, h: dh };
}
