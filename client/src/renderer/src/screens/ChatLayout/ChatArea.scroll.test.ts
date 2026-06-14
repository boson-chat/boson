import { describe, it, expect } from 'vitest';
import { resolveScrollTop } from './ChatArea';

// Viewport metrics: 300px tall window over `scrollHeight` of content.
const VIEW = 300;

describe('resolveScrollTop', () => {
  it('jumps to the bottom on a channel switch', () => {
    const prev = { name: '#a', count: 10, firstId: 'a1', scrollHeight: 1000 };
    const next = { name: '#b', count: 5, firstId: 'b1' };
    expect(resolveScrollTop(prev, next, { scrollTop: 0, clientHeight: VIEW, scrollHeight: 500 })).toBe(500);
  });

  it('preserves the viewport when older history is prepended', () => {
    const prev = { name: '#a', count: 10, firstId: 'm10', scrollHeight: 1000 };
    const next = { name: '#a', count: 60, firstId: 'm-old' }; // 50 older prepended
    // User parked at the top (scrollTop 0); content grew by 800px above.
    const target = resolveScrollTop(prev, next, { scrollTop: 0, clientHeight: VIEW, scrollHeight: 1800 });
    expect(target).toBe(800); // 0 + (1800 - 1000) → same content stays under the viewport
  });

  it('does NOT scroll when an unrelated emit fires while scrolled up (the load-older bug)', () => {
    // Same channel, same messages (e.g. history.loading flag flipped). User has
    // scrolled up to read history → must be left exactly where they are.
    const prev = { name: '#a', count: 10, firstId: 'm1', scrollHeight: 1000 };
    const next = { name: '#a', count: 10, firstId: 'm1' };
    expect(resolveScrollTop(prev, next, { scrollTop: 120, clientHeight: VIEW, scrollHeight: 1000 })).toBeNull();
  });

  it('sticks to the bottom on a live append when already at the bottom', () => {
    const prev = { name: '#a', count: 10, firstId: 'm1', scrollHeight: 1000 };
    const next = { name: '#a', count: 11, firstId: 'm1' }; // appended at the tail
    // Was at bottom before: scrollTop(700) + view(300) === prev height(1000).
    const target = resolveScrollTop(prev, next, { scrollTop: 700, clientHeight: VIEW, scrollHeight: 1080 });
    expect(target).toBe(1080);
  });

  it('does NOT stick to the bottom on a live append when scrolled up', () => {
    const prev = { name: '#a', count: 10, firstId: 'm1', scrollHeight: 1000 };
    const next = { name: '#a', count: 11, firstId: 'm1' };
    // Scrolled up: viewport bottom (300+300=600) is well above prev height 1000.
    expect(resolveScrollTop(prev, next, { scrollTop: 300, clientHeight: VIEW, scrollHeight: 1080 })).toBeNull();
  });
});
