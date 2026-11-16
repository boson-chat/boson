import { describe, it, expect } from 'vitest';
import { fitRect, phoneLayout, type PhoneItem } from './video.layout';

const W = 390;
const H = 791; // an iPhone 13 Pro's call stage, portrait
const inside = (r: { x: number; y: number; w: number; h: number }, w: number) => r.x >= 0 && r.x + r.w <= w + 0.01;
const people = (n: number, video = true, aspect = 16 / 9): PhoneItem<string>[] =>
  Array.from({ length: n }, (_, i) => ({ key: `p${i}`, self: i === 0, video, aspect: i === 0 ? 3 / 4 : aspect }));

describe('phoneLayout', () => {
  it('two people with video: the other big, ourselves a corner picture-in-picture', () => {
    const l = phoneLayout(people(2), W, H);
    expect(l.pip).toBe('p0');
    const other = l.rects.get('p1')!;
    const self = l.rects.get('p0')!;
    // A landscape camera on a portrait phone: across, at its aspect.
    expect(other.w).toBeCloseTo(W - 12);
    expect(other.w / other.h).toBeCloseTo(16 / 9, 1);
    expect(self.w).toBeLessThan(W / 2);
    expect(self.h / self.w).toBeCloseTo(4 / 3, 1);
    expect(self.x + self.w).toBeGreaterThan(W - 30); // bottom right
    expect(self.y + self.h).toBeGreaterThan(H - 30);
    const tl = phoneLayout(people(2), W, H, 'tl').rects.get('p0')!;
    expect(tl.x).toBeLessThan(30);
    expect(tl.y).toBeLessThan(30);
  });

  it('a portrait camera fills the stage', () => {
    const l = phoneLayout(people(2, true, 3 / 4), W, H);
    expect(l.rects.get('p1')!.h).toBeCloseTo(H - 12);
  });

  it('avatars get cards, never a whole tall column', () => {
    for (const n of [1, 2]) {
      const l = phoneLayout(people(n, false), W, H);
      expect(l.pip).toBeNull();
      for (const r of l.rects.values()) {
        expect(r!.h).toBeLessThanOrEqual(r!.w);
        expect(inside(r!, W)).toBe(true);
      }
    }
  });

  it('three or four: a 2×2 grid of near-square tiles inside the stage', () => {
    for (const n of [3, 4]) {
      const l = phoneLayout(people(n), W, H);
      expect(l.height).toBe(H);
      for (const r of l.rects.values()) {
        expect(r!.w).toBeCloseTo((W - 18) / 2);
        expect(r!.w / r!.h).toBeGreaterThan(0.7);
        expect(r!.w / r!.h).toBeLessThan(1.4);
        expect(inside(r!, W)).toBe(true);
        expect(r!.y + r!.h).toBeLessThanOrEqual(H);
      }
    }
  });

  it('more than fit: two columns that scroll', () => {
    const l = phoneLayout(people(9), W, 500);
    expect(l.height).toBeGreaterThan(500);
    expect([...l.rects.values()].every((r) => r && inside(r, W))).toBe(true);
  });

  it('a screen share goes on top, full width at its own aspect', () => {
    const items: PhoneItem<string>[] = [{ key: 's', screen: true, aspect: 16 / 10, video: true }, ...people(2)];
    const l = phoneLayout(items, W, H);
    const s = l.rects.get('s')!;
    expect(s.y).toBeLessThan(10);
    expect(s.w).toBeCloseTo(W - 12);
    expect(s.w / s.h).toBeCloseTo(16 / 10, 1);
    expect(l.pip).toBeNull();
    for (const k of ['p0', 'p1']) expect(l.rects.get(k)!.y).toBeGreaterThan(s.y + s.h);
  });

  it('on its side: the best-fitting grid, or the screen with a column of people', () => {
    const l = phoneLayout(people(5), 844, 337);
    for (const r of l.rects.values()) {
      expect(r!.w / r!.h).toBeGreaterThanOrEqual(4 / 3 - 0.01);
      expect(r!.w / r!.h).toBeLessThanOrEqual(16 / 9 + 0.01);
      expect(r!.y + r!.h).toBeLessThanOrEqual(337);
    }
    const sl = phoneLayout([{ key: 's', screen: true, aspect: 16 / 9 }, ...people(3)], 844, 337);
    expect(sl.height).toBe(337);
    expect(sl.rects.get('s')!.x).toBeLessThan(10);
  });
});

describe('fitRect', () => {
  it('contains screens and covers cameras, cropping at most a third', () => {
    const c = fitRect(1920, 1080, 400, 400, 'contain');
    expect(c.w).toBe(400);
    expect(c.h).toBeCloseTo(225);
    const cov = fitRect(640, 480, 400, 400, 'cover');
    expect(cov.h).toBe(400); // 4:3 in a square: fills, crops a quarter
    const lim = fitRect(1280, 720, 200, 700, 'cover'); // 16:9 in a sliver
    expect(lim.w / 200).toBeCloseTo(1.5); // a third cropped, no more
    expect(lim.h).toBeLessThan(700);
  });
});
