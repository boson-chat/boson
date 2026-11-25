import { describe, expect, it } from 'vitest';
import { markStripEdges, revealTab } from './tab-strip';

// jsdom has no layout: a strip `w` wide of `n` 80px tabs, scrolled to `scrollLeft`.
function strip(w: number, n: number, scrollLeft = 0): { nav: HTMLElement; tabs: HTMLElement[] } {
  const nav = document.createElement('nav');
  const tabs: HTMLElement[] = [];
  for (let i = 0; i < n; i++) {
    const t = document.createElement('div');
    t.getBoundingClientRect = () => ({ left: i * 80 - nav.scrollLeft }) as DOMRect;
    Object.defineProperty(t, 'offsetWidth', { value: 80 });
    nav.appendChild(t);
    tabs.push(t);
  }
  Object.defineProperty(nav, 'clientWidth', { value: w });
  Object.defineProperty(nav, 'scrollWidth', { value: n * 80 });
  nav.getBoundingClientRect = () => ({ left: 0 }) as DOMRect;
  nav.scrollLeft = scrollLeft;
  return { nav, tabs };
}

describe('revealTab', () => {
  it('brings a tab past the end into view with room to spare', () => {
    const { nav, tabs } = strip(300, 8);
    revealTab(nav, tabs[5]!);
    // tab 5 spans 400–480: 480 - 300 + 24.
    expect(nav.scrollLeft).toBe(204);
  });

  it('stops at the end of the strip for the last tab', () => {
    const { nav, tabs } = strip(300, 8);
    revealTab(nav, tabs[7]!);
    expect(nav.scrollLeft).toBe(340);
  });

  it('scrolls back for a tab before the start', () => {
    const { nav, tabs } = strip(300, 8, 300);
    revealTab(nav, tabs[2]!);
    expect(nav.scrollLeft).toBe(136);
  });

  it('leaves a strip that fits alone', () => {
    const { nav, tabs } = strip(800, 4);
    revealTab(nav, tabs[3]!);
    expect(nav.scrollLeft).toBe(0);
  });
});

describe('markStripEdges', () => {
  it('marks the edges with more tabs past them', () => {
    const { nav } = strip(300, 8, 100);
    markStripEdges(nav);
    expect(nav.hasAttribute('data-more-start')).toBe(true);
    expect(nav.hasAttribute('data-more-end')).toBe(true);
  });
});
