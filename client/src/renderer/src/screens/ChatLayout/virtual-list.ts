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
