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

// ---- phones ----

export interface PhoneItem<K> {
  key: K;
  screen?: boolean; // a screen share: full width at its own aspect, on top
  self?: boolean; // our own tile: the picture-in-picture in a 1:1 call
  video?: boolean; // shows video (else an avatar: a card, never a whole column)
  aspect?: number; // the video's width/height, when known
}

export type Corner = 'tl' | 'tr' | 'bl' | 'br';

export interface PhoneLayout<K> {
  rects: Map<K, Rect | null>;
  height: number; // the content's height: more than the stage's scrolls
  pip: K | null; // the self tile floating over the other person
}

const GAP = 6;
const SELF_ASPECT = 3 / 4;

/**
 * The call on a phone (or a phone on its side):
 * - a screen share on top (portrait) or at the left (landscape), the whole
 *   width at its own aspect;
 * - one other person: them filling the stage, ourselves as a small
 *   picture-in-picture in `corner`;
 * - three or four: a 2×2 grid of near-square tiles; more: two columns that
 *   scroll (portrait), or the best-fitting grid on a phone's side.
 * Avatar-only tiles take the same cards as video, never a whole tall column.
 */
export function phoneLayout<K>(items: PhoneItem<K>[], w: number, h: number, corner: Corner = 'br'): PhoneLayout<K> {
  const rects = new Map<K, Rect | null>(items.map((i) => [i.key, null]));
  const out: PhoneLayout<K> = { rects, height: h, pip: null };
  if (items.length === 0 || w <= 0 || h <= 0) return out;
  const screens = items.filter((i) => i.screen).slice(0, 2);
  const people = items.filter((i) => !i.screen).slice(0, MAX_TILES);
  const portrait = h >= w;

  // One other person with video and nothing shared: them big, us small.
  const other1 = people.length === 2 ? people.find((p) => !p.self) : undefined;
  if (screens.length === 0 && other1?.video && people.some((p) => p.self)) {
    const self = people.find((p) => p.self)!;
    const other = other1;
    const oa = other.aspect ?? 0;
    if (portrait && oa > 1) {
      // A landscape camera on a portrait phone: the whole picture, across.
      const th = Math.min((w - 2 * GAP) / oa, h - 2 * GAP);
      rects.set(other.key, { x: GAP, y: (h - th) / 2, w: w - 2 * GAP, h: th });
    } else {
      rects.set(other.key, { x: GAP, y: GAP, w: w - 2 * GAP, h: h - 2 * GAP });
    }
    const a = self.aspect ?? SELF_ASPECT;
    // About a third of the short side, never smaller than a thumb's reach.
    let pw: number;
    let ph: number;
    if (a < 1) {
      ph = clamp(Math.round(Math.min(w, h) * (portrait ? 0.42 : 0.5)), 110, 220);
      pw = Math.round(ph * a);
    } else {
      pw = clamp(Math.round(Math.min(w, h) * (portrait ? 0.36 : 0.4)), 110, 220);
      ph = Math.round(pw / a);
    }
    const m = 12;
    const x = corner === 'tl' || corner === 'bl' ? GAP + m : w - GAP - m - pw;
    const y = corner === 'tl' || corner === 'tr' ? GAP + m : h - GAP - m - ph;
    rects.set(self.key, { x, y, w: pw, h: ph });
    out.pip = self.key;
    return out;
  }

  if (!portrait) return landscape(screens, people, w, h, out);

  let y = GAP;
  const fullW = w - 2 * GAP;
  for (const s of screens) {
    const sh = Math.round(Math.min(fullW / (s.aspect ?? 16 / 9), h * 0.5));
    rects.set(s.key, { x: GAP, y, w: fullW, h: sh });
    y += sh + GAP;
  }
  const availH = h - y - GAP;
  const n = people.length;
  if (n === 0) return out;
  const under = screens.length > 0; // cards start right under a screen share
  if (n === 1 || (n === 2 && !under)) {
    // Alone, or two without a picture-in-picture (the other has no video):
    // full-width cards, a picture filling the stage only when alone with
    // video.
    const one = people[0];
    const fill = n === 1 && one.video && !under;
    const ch = fill ? availH : Math.round(Math.min((availH - (n - 1) * GAP) / n, fullW * (one.video && (one.aspect ?? 1) < 1 ? 1.33 : 0.75)));
    const total = n * ch + (n - 1) * GAP;
    const top = under ? y : y + Math.max(0, (availH - total) / 2);
    people.forEach((p, i) => rects.set(p.key, { x: GAP, y: top + i * (ch + GAP), w: fullW, h: ch }));
    out.height = Math.max(h, top + total + GAP);
    return out;
  }
  // Three or more (or two under a screen): two columns of cards shaped like
  // most of the cameras (4:3 for laptops' landscape, 4:5 for phones'
  // portrait, square for avatars); 3–4 fit as 2×2, more scroll.
  const tw = (w - 3 * GAP) / 2;
  const rows = Math.ceil(n / 2);
  const wideCams = people.filter((p) => p.video && (p.aspect ?? 16 / 9) > 1).length;
  const tallCams = people.filter((p) => p.video && (p.aspect ?? 16 / 9) < 1).length;
  const ratio = wideCams > tallCams ? 0.75 : tallCams > 0 ? 1.25 : 1;
  let th = tw * ratio;
  if (n <= 4) th = Math.max(tw * 0.6, Math.min(th, (availH - (rows - 1) * GAP) / rows));
  const gridH = rows * th + (rows - 1) * GAP;
  const top = n <= 4 && gridH < availH && !under ? y + (availH - gridH) / 2 : y;
  people.forEach((p, i) => {
    const r = Math.floor(i / 2);
    const c = i % 2;
    // An odd last tile sits in the middle.
    const x = n % 2 === 1 && i === n - 1 ? (w - tw) / 2 : GAP + c * (tw + GAP);
    rects.set(p.key, { x, y: top + r * (th + GAP), w: tw, h: th });
  });
  out.height = Math.max(h, top + gridH + GAP);
  return out;
}

function landscape<K>(screens: PhoneItem<K>[], people: PhoneItem<K>[], w: number, h: number, out: PhoneLayout<K>): PhoneLayout<K> {
  const { rects } = out;
  let x0 = GAP;
  let areaW = w - 2 * GAP;
  if (screens.length > 0) {
    // The screen at the left at its aspect; people in a column at the right.
    const colW = people.length > 0 ? Math.round(clamp(w * 0.26, 140, 240)) : 0;
    const sw = areaW - (colW ? colW + GAP : 0);
    const s = screens[0];
    const a = s.aspect ?? 16 / 9;
    const shH = Math.min(h - 2 * GAP, sw / a);
    rects.set(s.key, { x: GAP, y: (h - shH) / 2, w: sw, h: shH });
    if (!colW) return out;
    const th = Math.floor(Math.max(colW * 0.45, Math.min(colW * 0.75, (h - (people.length + 1) * GAP) / people.length)));
    people.forEach((p, i) => rects.set(p.key, { x: w - GAP - colW, y: GAP + i * (th + GAP), w: colW, h: th }));
    out.height = Math.max(h, GAP + people.length * (th + GAP));
    return out;
  }
  // The grid whose cells hold the biggest 4:3–16:9 card.
  const n = people.length;
  let best = { cols: 1, cw: 0, ch: 0, area: -1 };
  for (let cols = 1; cols <= n; cols++) {
    const rows = Math.ceil(n / cols);
    const cellW = (areaW - (cols - 1) * GAP) / cols;
    const cellH = (h - 2 * GAP - (rows - 1) * GAP) / rows;
    // The card: as wide as 16:9 at most, as tall as 4:3 at most.
    const cw = Math.min(cellW, cellH * (16 / 9));
    const ch = Math.min(cellH, cw / (4 / 3));
    if (cw * ch > best.area) best = { cols, cw, ch, area: cw * ch };
  }
  const rows = Math.ceil(n / best.cols);
  const gridW = best.cols * best.cw + (best.cols - 1) * GAP;
  const gridH = rows * best.ch + (rows - 1) * GAP;
  x0 = (w - gridW) / 2;
  const y0 = (h - gridH) / 2;
  people.forEach((p, i) => {
    const r = Math.floor(i / best.cols);
    const inRow = r === rows - 1 ? n - r * best.cols : best.cols;
    const rowX = x0 + (gridW - (inRow * best.cw + (inRow - 1) * GAP)) / 2;
    const c = i - r * best.cols;
    rects.set(p.key, { x: rowX + c * (best.cw + GAP), y: y0 + r * (best.ch + GAP), w: best.cw, h: best.ch });
  });
  return out;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
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
