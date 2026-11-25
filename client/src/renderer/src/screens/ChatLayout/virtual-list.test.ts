import { describe, expect, it } from 'vitest';
import {
  bottomOf, captureAnchor, DEFAULT_ROW_HEIGHT, HeightCache, Layout, placeAnchored, restoreAnchor, userAtBottom,
} from './virtual-list';

const keys = (n: number, from = 0) => Array.from({ length: n }, (_, i) => `m${i + from}`);

describe('HeightCache', () => {
  it('estimates unmeasured rows from the measured ones', () => {
    const h = new HeightCache();
    expect(h.estimate()).toBe(DEFAULT_ROW_HEIGHT);
    h.set('a', 20);
    h.set('b', 40);
    expect(h.estimate()).toBe(30);
    expect(h.set('a', 20)).toBe(false);
    expect(h.set('a', 60)).toBe(true);
    expect(h.estimate()).toBe(50);
  });
  it('is bounded, oldest out first', () => {
    const h = new HeightCache(2);
    h.set('a', 10); h.set('b', 20); h.set('c', 30);
    expect(h.get('a')).toBeUndefined();
    expect(h.size).toBe(2);
    expect(h.estimate()).toBe(25);
  });
});

describe('Layout', () => {
  it('offsets, total, and the rows covering a viewport plus overscan', () => {
    const h = new HeightCache();
    keys(100).forEach((k) => h.set(k, 10));
    const l = new Layout(keys(100), h, 40); // 40 px of header above the rows
    expect(l.total).toBe(1040);
    expect(l.offsetOf(3)).toBe(70);
    expect(l.indexAt(0)).toBe(0);
    expect(l.indexAt(75)).toBe(3);
    expect(l.indexAt(99999)).toBe(99);
    // Viewport 500..600, overscan 50 → rows covering 450..650.
    expect(l.range(500, 100, 50)).toEqual({ start: 41, end: 62 });
    expect(l.range(0, 100, 0)).toEqual({ start: 0, end: 7 });
    expect(new Layout([], h).range(0, 100, 10)).toEqual({ start: 0, end: 0 });
  });

  it('unmeasured rows take the estimate', () => {
    const h = new HeightCache();
    h.set('m0', 100);
    const l = new Layout(keys(3), h);
    expect(l.total).toBe(300);
  });
});

describe('anchoring', () => {
  it('older rows prepended: the row being read stays put', () => {
    const h = new HeightCache();
    keys(300).forEach((k, i) => h.set(k, 20 + (i % 3) * 10));
    const before = new Layout(keys(100, 200), h);
    const scrollTop = 777;
    const a = captureAnchor(before, scrollTop)!;
    const after = new Layout(keys(300), h); // 200 older rows above
    const next = restoreAnchor(after, a)!;
    // Same row at the same distance from the viewport's top.
    expect(next - after.offsetOf(after.indexOf(a.key))).toBe(a.delta);
    expect(next).toBeGreaterThan(scrollTop);
  });

  it('a row above growing (its image loaded) moves the view by as much', () => {
    const h = new HeightCache();
    keys(50).forEach((k) => h.set(k, 30));
    const l1 = new Layout(keys(50), h);
    const a = captureAnchor(l1, 600)!;
    expect(a).toEqual({ key: 'm20', delta: 0 });
    h.set('m5', 230); // +200
    const l2 = new Layout(keys(50), h);
    expect(restoreAnchor(l2, a)).toBe(800);
  });

  it('a row below growing changes nothing above it', () => {
    const h = new HeightCache();
    keys(50).forEach((k) => h.set(k, 30));
    const a = captureAnchor(new Layout(keys(50), h), 615)!;
    h.set('m40', 500);
    expect(restoreAnchor(new Layout(keys(50), h), a)).toBe(615);
  });

  it('rows trimmed off the top: still the same row', () => {
    const h = new HeightCache();
    keys(300).forEach((k) => h.set(k, 25));
    const a = captureAnchor(new Layout(keys(300), h), 6010)!; // row 240, 10 in
    expect(restoreAnchor(new Layout(keys(200, 100), h), a)).toBe(3510);
  });

  it('an anchor row that is gone gives nothing (the caller decides)', () => {
    const h = new HeightCache();
    const a = captureAnchor(new Layout(keys(10), h), 100)!;
    expect(restoreAnchor(new Layout(keys(10, 50), h), a)).toBeNull();
    expect(captureAnchor(new Layout([], h), 0)).toBeNull();
  });

  it('bottom', () => {
    expect(bottomOf(1000, 300)).toBe(700);
    expect(bottomOf(100, 300)).toBe(0);
  });
});

describe('placeAnchored: keeping the reader\'s row without fighting their scroll', () => {
  const base = { scrollTop: 1000, skew: 0, topPad: 600, start: 10 };

  it('not scrolling: moves scrollTop to the row (and no skew)', () => {
    expect(placeAnchored({ ...base, target: 1040, active: false })).toEqual({ scrollTop: 1040, skew: 0 });
    expect(placeAnchored({ ...base, target: 1000.3, active: false })).toEqual({ scrollTop: null, skew: 0 });
  });

  it('mid-scroll: the top spacer takes the difference, scrollTop is left alone', () => {
    // Rows above came in 40px taller than estimated: the model's target is
    // 40px further down; the spacer grows 40px less → skew −40.
    expect(placeAnchored({ ...base, target: 1040, active: true })).toEqual({ scrollTop: null, skew: -40 });
    // Shorter than estimated: skew +25.
    expect(placeAnchored({ ...base, target: 975, active: true })).toEqual({ scrollTop: null, skew: 25 });
    // Already in place with the skew it has: nothing changes.
    expect(placeAnchored({ ...base, target: 1040, skew: -40, active: true })).toEqual({ scrollTop: null, skew: -40 });
  });

  it('settles once the scroll stops: skew gone, scrollTop moved by it in one write', () => {
    // Skew −40 kept the row at 1000 on screen; the model has it at 1040.
    expect(placeAnchored({ ...base, target: 1040, skew: -40, active: false })).toEqual({ scrollTop: 1040, skew: 0 });
  });

  it('writes instead when the spacer can\'t take it (or there is none)', () => {
    // The spacer would go below zero.
    expect(placeAnchored({ ...base, topPad: 30, target: 1040, active: true })).toEqual({ scrollTop: 1040, skew: 0 });
    // The first row is rendered: a skew would be a gap above it.
    expect(placeAnchored({ ...base, start: 0, target: 1040, skew: -10, active: true })).toEqual({ scrollTop: 1040, skew: 0 });
  });

  it('no anchor: settles any skew in place', () => {
    expect(placeAnchored({ ...base, target: null, skew: 30, active: true })).toEqual({ scrollTop: 970, skew: 0 });
    expect(placeAnchored({ ...base, target: null, active: true })).toEqual({ scrollTop: null, skew: 0 });
  });
});

describe('userAtBottom', () => {
  it('scrolling up leaves the bottom at once, even inside the slack', () => {
    expect(userAtBottom(4, true, 24)).toBe(false);
    expect(userAtBottom(0.5, true, 24)).toBe(true);
  });
  it('scrolling down reaches it within the slack', () => {
    expect(userAtBottom(20, false, 24)).toBe(true);
    expect(userAtBottom(30, false, 24)).toBe(false);
  });
});
