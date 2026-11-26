// Windowing math for the message list (pure; MessageList does the DOM).
//
// Rows have variable heights: each row's measured height is kept per row
// key (message id) in a HeightCache; rows not measured yet use an estimate
// (the running average of measured ones). From those, a Layout gives every
// row's offset, which rows cover the viewport (plus overscan), and the
// total height the spacers stand in for.
//
// Keeping the reader's place: before a change (rows prepended, a row above
// growing when its image loads, rows trimmed off the top) an Anchor records
// the row at the top of the viewport and how far into it the viewport
// starts; after it, restoreAnchor gives the scrollTop that puts that same
// row at the same place. Reading at the bottom is simpler: stay at the
// bottom.

export const DEFAULT_ROW_HEIGHT = 44;

// Heights by row key, shared across the list's renders (and channels: a
// conversation reopened is laid out at once). Bounded: oldest out first.
export class HeightCache {
  private readonly heights = new Map<string, number>();
  private sum = 0;

  constructor(private readonly max = 20_000) {}

  get(key: string): number | undefined {
    return this.heights.get(key);
  }

  // Records a measured height; true when it changed.
  set(key: string, h: number): boolean {
    const v = Math.max(0, Math.round(h * 100) / 100);
    const have = this.heights.get(key);
    if (have === v) return false;
    if (have !== undefined) {
      this.sum -= have;
      this.heights.delete(key);
    }
    this.heights.set(key, v);
    this.sum += v;
    while (this.heights.size > this.max) {
      const [k, old] = this.heights.entries().next().value!;
      this.heights.delete(k);
      this.sum -= old;
    }
    return true;
  }

  // A measured row known to have grown (or shrunk) by `delta` since: a
  // row off screen that gained a line. Unmeasured rows stay estimates.
  adjust(key: string, delta: number): boolean {
    const have = this.heights.get(key);
    return have === undefined ? false : this.set(key, have + delta);
  }

  // The height to assume for a row not measured yet.
  estimate(): number {
    return this.heights.size > 0 ? this.sum / this.heights.size : DEFAULT_ROW_HEIGHT;
  }

  get size(): number {
    return this.heights.size;
  }
}

export class Layout {
  // offsets[i] = top of row i; offsets[n] = total height.
  readonly offsets: Float64Array;
  private readonly indexByKey = new Map<string, number>();

  constructor(readonly keys: readonly string[], heights: HeightCache, readonly top = 0) {
    this.offsets = new Float64Array(keys.length + 1);
    const est = heights.estimate();
    let y = top;
    for (let i = 0; i < keys.length; i++) {
      this.offsets[i] = y;
      this.indexByKey.set(keys[i]!, i);
      y += heights.get(keys[i]!) ?? est;
    }
    this.offsets[keys.length] = y;
  }

  get total(): number {
    return this.offsets[this.keys.length]!;
  }

  indexOf(key: string): number {
    return this.indexByKey.get(key) ?? -1;
  }

  offsetOf(i: number): number {
    return this.offsets[Math.max(0, Math.min(i, this.keys.length))]!;
  }

  // The row covering y (the last row when y is past the end, 0 before it).
  indexAt(y: number): number {
    const n = this.keys.length;
    if (n === 0) return 0;
    let lo = 0;
    let hi = n - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.offsets[mid]! <= y) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }

  // Rows [start, end) to render for a viewport at scrollTop of height
  // `viewport`, with `overscan` px more on each side.
  range(scrollTop: number, viewport: number, overscan: number): { start: number; end: number } {
    const n = this.keys.length;
    if (n === 0) return { start: 0, end: 0 };
    const start = this.indexAt(Math.max(0, scrollTop - overscan));
    const end = Math.min(n, this.indexAt(scrollTop + viewport + overscan) + 1);
    return { start, end };
  }
}

export interface Anchor {
  key: string;
  // scrollTop − the row's top.
  delta: number;
  // The messages in that row (local ids). A row can be re-keyed under the
  // reader: a collapsed join/part block or a run of preformatted lines is
  // keyed by its first line, so lines loaded above that join it give it a
  // new key. The row holding one of these is the same place.
  ids?: readonly string[];
}

// The anchor as it stands in `layout`: itself, or re-keyed to the row that
// now holds its messages (`rowOf`: a message id's row key), or null.
export function locateAnchor(
  layout: Layout, anchor: Anchor | null, rowOf: (id: string) => string | undefined,
): Anchor | null {
  if (!anchor) return null;
  if (layout.indexOf(anchor.key) >= 0) return anchor;
  for (const id of anchor.ids ?? []) {
    const key = rowOf(id);
    if (key !== undefined && layout.indexOf(key) >= 0) return { ...anchor, key };
  }
  return null;
}

// The row at the top of the viewport and how far into it.
export function captureAnchor(layout: Layout, scrollTop: number): Anchor | null {
  if (layout.keys.length === 0) return null;
  const i = layout.indexAt(scrollTop);
  return { key: layout.keys[i]!, delta: scrollTop - layout.offsetOf(i) };
}

// Where to scroll so the anchor row sits where it was (null: it's gone).
export function restoreAnchor(layout: Layout, anchor: Anchor | null): number | null {
  if (!anchor) return null;
  const i = layout.indexOf(anchor.key);
  if (i < 0) return null;
  return Math.max(0, layout.offsetOf(i) + anchor.delta);
}

// The scrollTop of the very bottom.
export function bottomOf(scrollHeight: number, clientHeight: number): number {
  return Math.max(0, scrollHeight - clientHeight);
}

// ---- keeping the place without fighting the user's scroll ----
//
// Rows above the viewport change height as the user scrolls back (rows
// measured for the first time, unlike the estimate they were laid out at).
// Keeping the reader's row in place then takes a scrollTop write, and a
// write in the middle of the user's own scroll is what made it skip: it
// cancels the browser's smooth wheel / keyboard scroll animation (Chromium,
// WebView2), races the scrolling thread (WebKit: the next wheel delta lands
// on the old position), and stops a fling on iOS. So while the user is
// scrolling the difference goes into the top spacer instead ("skew": how
// much taller it is than the rows it stands for), which keeps the row where
// it is without touching scrollTop; once they've stopped, the spacer is set
// right and scrollTop moved by the same amount in one go (nothing on
// screen moves).

export interface PlaceArgs {
  // The scroller's scrollTop now (the DOM's: model + skew).
  scrollTop: number;
  // The scrollTop (DOM) that keeps the anchor row in place with no skew
  // (restoreAnchor), or null when there's no anchor to keep.
  target: number | null;
  // The top spacer's current skew.
  skew: number;
  // The top spacer's height in the model (the rows above `start`).
  topPad: number;
  // The first row in the DOM (0: no rows above it stand in a spacer, so a
  // skew would show as a gap above the first row).
  start: number;
  // The user is scrolling right now (a finger down, a wheel / key / drag
  // scroll within the last moment).
  active: boolean;
  // Where the top spacer starts (DOM): with start 0 a skew shows as a gap
  // between it and the first row, fine while that gap is above the viewport.
  spacerTop?: number;
}

export interface Placement {
  // The scrollTop to write, or null to leave it.
  scrollTop: number | null;
  skew: number;
}

export function placeAnchored({ scrollTop, target, skew, topPad, start, active, spacerTop }: PlaceArgs): Placement {
  const write = (to: number): Placement => ({ scrollTop: Math.abs(to - scrollTop) > 0.5 ? to : null, skew: 0 });
  if (target === null) return skew === 0 ? { scrollTop: null, skew: 0 } : write(Math.max(0, scrollTop - skew));
  if (active) {
    const next = scrollTop - target;
    // The first row in the DOM: the gap a skew leaves above it must stay
    // out of sight (rows above it in the spacer always cover it).
    const hidden = start > 0 || (spacerTop !== undefined && scrollTop >= spacerTop + next);
    if (hidden && topPad + next >= 0) return { scrollTop: null, skew: Math.abs(next - skew) <= 0.5 ? skew : next };
  }
  return write(Math.max(0, target));
}

// Whether the user's own scroll leaves the list at the bottom. Scrolling
// up leaves it as soon as it moves (a slow trackpad scroll moves a few px
// at a time: within the slack it was pulled back down on every frame and
// never got away); scrolling down to within `slack` of the end reaches it.
export function userAtBottom(distance: number, movedUp: boolean, slack: number): boolean {
  return movedUp ? distance <= 1 : distance <= slack;
}
