import { describe, it, expect } from 'vitest';
import { fitRect } from './video.layout';

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
