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

/** Data saver's ceiling for cameras: layers whose short side is at most
 * this (360p). */
export const DATA_SAVER_CAMERA_MAX = 360;

/** The layer to receive for a track's tile: cameras by tile size; screen
 * shares their top layer (their small one runs at half the rate). With
 * data saver, cameras stop at 360p and screen shares take their low layer.
 * null = receive nothing. */
export function layerFor(
  kind: string, layers: VideoLayer[], w: number, h: number, visible: boolean, dataSaver: boolean,
): number | null {
  if (!visible || layers.length === 0) return null;
  const area = (l: VideoLayer): number => l.width * l.height;
  if (kind === 'screen') {
    const pick = dataSaver
      ? layers.reduce((a, b) => (area(b) < area(a) ? b : a))
      : layers.reduce((a, b) => (area(b) > area(a) ? b : a));
    return pick.id;
  }
  if (dataSaver) {
    const small = layers.filter((l) => Math.min(l.width, l.height) <= DATA_SAVER_CAMERA_MAX);
    // A sender without a small enough layer: its smallest.
    const pool = small.length ? small : [layers.reduce((a, b) => (area(b) < area(a) ? b : a))];
    return layerForTile(pool, w, h, visible);
  }
  return layerForTile(layers, w, h, visible);
}
