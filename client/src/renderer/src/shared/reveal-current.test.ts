import { describe, expect, it } from 'vitest';
import { revealCurrent } from './reveal-current';

// jsdom has no layout: a list `h` tall scrolled to `scrollTop`, rows of 40px.
function list(h: number, rows: number, current: number, scrollTop = 0): HTMLElement {
  const el = document.createElement('div');
  for (let i = 0; i < rows; i++) {
    const r = document.createElement('div');
    if (i === current) r.className = 'on';
    r.getBoundingClientRect = () => ({ top: i * 40 - el.scrollTop, bottom: i * 40 + 40 - el.scrollTop, height: 40 }) as DOMRect;
    el.appendChild(r);
  }
  Object.defineProperty(el, 'clientHeight', { value: h });
  Object.defineProperty(el, 'scrollHeight', { value: rows * 40 });
  el.getBoundingClientRect = () => ({ top: 0, bottom: h, height: h }) as DOMRect;
  el.scrollTop = scrollTop;
  return el;
}

describe('revealCurrent', () => {
  it('centres a row below the fold', () => {
    const el = list(400, 30, 20);
    revealCurrent(el, '.on');
    // row 20 spans 800–840; centred in 400px → scrollTop 620.
    expect(el.scrollTop).toBe(620);
  });

  it('leaves a row that already shows alone', () => {
    const el = list(400, 30, 3);
    revealCurrent(el, '.on');
    expect(el.scrollTop).toBe(0);
  });

  it('does not scroll past the end', () => {
    const el = list(400, 30, 29);
    revealCurrent(el, '.on');
    expect(el.scrollTop).toBe(30 * 40 - 400);
  });

  it('scrolls back up to a row above the view', () => {
    const el = list(400, 30, 2, 600);
    revealCurrent(el, '.on');
    expect(el.scrollTop).toBe(0);
  });

  it('does nothing without a current row or a list', () => {
    const el = list(400, 30, -1, 100);
    revealCurrent(el, '.on');
    expect(el.scrollTop).toBe(100);
    expect(() => revealCurrent(null, '.on')).not.toThrow();
  });
});
