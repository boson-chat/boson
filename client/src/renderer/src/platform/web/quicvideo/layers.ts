// Copied from boson-chat/quicvideo@v1.14.0 (80ae103) web/src (layers.ts). Keep in sync; local changes are marked "boson:".
// Layer ladders, tile → layer mapping and the tile layout: the same rules
// as client/media (layers.go) and the desktop viewer (layout.go).
import type { Layer } from "./gen/quicvideo/v1/control_pb";

export interface LayerSpec {
  id: number;
  width: number;
  height: number;
  fps: number;
  bitrate: number;
}

const even = (v: number) => Math.max(v & ~1, 2);

function fit(w: number, h: number, maxW: number, maxH: number): [number, number] {
  const s = Math.min(1, maxW / w, maxH / h);
  return [even(Math.round(w * s)), even(Math.round(h * s))];
}

function ladder(steps: [number, number, number][], bpp: number, floor: number, ceil: number): LayerSpec[] {
  const out: LayerSpec[] = [];
  steps.forEach(([w, h, fps], i) => {
    let br = Math.round((w * h * fps * bpp) / 10_000) * 10_000;
    br = Math.min(Math.max(br, floor), ceil);
    if (i > 0 && br <= out[i - 1].bitrate) br = out[i - 1].bitrate + 50_000;
    out.push({ id: i, width: w, height: h, fps, bitrate: br });
  });
  return out;
}

export function cameraLayers(w: number, h: number, fps: number): LayerSpec[] {
  const [tw, th] = fit(w, h, 1280, 720);
  return ladder([[even(tw / 4), even(th / 4), Math.max(Math.floor(fps / 2), 1)], [even(tw / 2), even(th / 2), fps], [tw, th, fps]],
    0.042, 100_000, 2_500_000);
}

/** A screen share's capture rate and top layer's fps (client/media ScreenFPS). */
export const SCREEN_FPS = 30;

export function screenLayers(w: number, h: number): LayerSpec[] {
  const [lw, lh] = fit(w, h, 1280, 1280);
  const [hw, hh] = fit(w, h, 1920, 1920);
  // As client/media: 15 fps at the small layer (phones get it), 30 at the top.
  if (lw === hw) return ladder([[lw, lh, SCREEN_FPS]], 0.05, 400_000, 4_000_000);
  return ladder([[lw, lh, 15], [hw, hh, SCREEN_FPS]], 0.05, 400_000, 4_000_000);
}

/** The max layer for a tile of w×h device pixels (null: unsubscribe). */
export function layerForTile(layers: Layer[], w: number, h: number, visible: boolean): number | null {
  if (!visible || w <= 0 || h <= 0 || layers.length === 0) return null;
  const sorted = [...layers].sort((a, b) => a.width * a.height - b.width * b.height);
  for (const l of sorted) {
    if (l.width <= 0 || l.height <= 0) continue;
    if (Math.min(w / l.width, h / l.height) <= 1 / 0.9) return l.id;
  }
  return sorted[sorted.length - 1].id;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Grid, or a pinned big tile plus a strip (same as examples/viewer). */
export function layout(ids: number[], pinned: number, w: number, h: number): Map<number, Rect | null> {
  const gap = 6;
  const out = new Map<number, Rect | null>(ids.map((id) => [id, null]));
  if (ids.length === 0 || w <= 0 || h <= 0) return out;
  if (pinned && ids.includes(pinned) && ids.length > 1) {
    const stripH = Math.max(90, h * 0.22);
    out.set(pinned, { x: gap, y: gap, w: w - 2 * gap, h: h - stripH - 3 * gap });
    const others = ids.filter((id) => id !== pinned).slice(0, 6);
    const tw = Math.min((w - gap * (others.length + 1)) / others.length, (stripH * 16) / 9);
    others.forEach((id, k) => out.set(id, { x: gap + k * (tw + gap), y: h - stripH - gap, w: tw, h: stripH }));
    return out;
  }
  const n = Math.min(ids.length, 9);
  const cols = Math.ceil(Math.sqrt(n));
  const rows = Math.ceil(n / cols);
  const tw = (w - gap * (cols + 1)) / cols;
  const th = (h - gap * (rows + 1)) / rows;
  ids.slice(0, n).forEach((id, i) => {
    const r = Math.floor(i / cols);
    const c = i % cols;
    out.set(id, { x: gap + c * (tw + gap), y: gap + r * (th + gap), w: tw, h: th });
  });
  return out;
}

/** An avc1 codec string (Constrained Baseline) with a level for w×h@fps. */
export function avcCodec(w: number, h: number, fps: number): string {
  const mbs = Math.ceil(w / 16) * Math.ceil(h / 16);
  const rate = mbs * fps;
  const levels: [number, number, number][] = [
    [0x1e, 1620, 40500], [0x1f, 3600, 108000], [0x20, 5120, 216000], [0x28, 8192, 245760],
    [0x2a, 8704, 522240], [0x32, 22080, 589824], [0x33, 36864, 983040],
  ];
  const lvl = levels.find(([, maxFs, maxRate]) => mbs <= maxFs && rate <= maxRate) ?? levels[levels.length - 1];
  return "avc1.42e0" + lvl[0].toString(16).padStart(2, "0");
}
