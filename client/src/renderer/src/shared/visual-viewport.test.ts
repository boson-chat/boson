import { describe, it, expect, afterEach } from 'vitest';
import { applyViewport, trackVisualViewport, KEYBOARD_MIN_PX, type ViewportEnv } from './visual-viewport';

class FakeVV extends EventTarget {
  height = 800;
  offsetTop = 0;
  width = 390;
}

function env(vv: FakeVV, scroll = { y: 0 }): ViewportEnv {
  return {
    root: document.documentElement,
    vv,
    layoutHeight: () => 800,
    scrollY: () => scroll.y,
    scrollTo: (y) => { scroll.y = y; },
  };
}

afterEach(() => {
  const root = document.documentElement;
  root.classList.remove('vv-tracked', 'kb-open');
  root.style.removeProperty('--app-height');
  root.style.removeProperty('--app-top');
});

describe('applyViewport', () => {
  it('sizes the app to the visible area', () => {
    const vv = new FakeVV();
    applyViewport(env(vv), 800);
    expect(document.documentElement.style.getPropertyValue('--app-height')).toBe('800px');
    expect(document.documentElement.classList.contains('kb-open')).toBe(false);
  });

  it('a keyboard: the app ends above it, marked kb-open, and the page scroll WebKit added is undone', () => {
    const vv = new FakeVV();
    vv.height = 464;
    const scroll = { y: 336 };
    applyViewport(env(vv, scroll), 800);
    expect(document.documentElement.style.getPropertyValue('--app-height')).toBe('464px');
    expect(document.documentElement.classList.contains('kb-open')).toBe(true);
    expect(scroll.y).toBe(0);
  });

  it('a small shrink (browser chrome) is not a keyboard', () => {
    const vv = new FakeVV();
    vv.height = 800 - KEYBOARD_MIN_PX + 1;
    applyViewport(env(vv), 800);
    expect(document.documentElement.classList.contains('kb-open')).toBe(false);
  });

  it('follows a visual viewport panned down the page', () => {
    const vv = new FakeVV();
    vv.height = 464;
    vv.offsetTop = 120;
    applyViewport(env(vv), 800);
    expect(document.documentElement.style.getPropertyValue('--app-top')).toBe('120px');
  });

  it('a fractional viewport (a scaled phone) rounds down, so the app is never taller than the page', () => {
    const vv = new FakeVV();
    vv.height = 733.91; // 844pt / 1.15
    vv.offsetTop = 40.6;
    applyViewport(env(vv), 800);
    expect(document.documentElement.style.getPropertyValue('--app-height')).toBe('733px');
    expect(document.documentElement.style.getPropertyValue('--app-top')).toBe('40px');
  });
});

describe('trackVisualViewport', () => {
  // Animation frames, run when the test says.
  let frames: FrameRequestCallback[] = [];
  const flush = (): void => { const f = frames; frames = []; f.forEach((fn) => fn(0)); };
  const fakeWindow = (vv: FakeVV, opts: { coarse: boolean; platform?: string }): Window => {
    const target = new EventTarget();
    return Object.assign(target, {
      visualViewport: vv,
      document,
      innerHeight: 800,
      scrollY: 0,
      scrollTo: () => {},
      bosonPlatform: opts.platform,
      matchMedia: (q: string) => ({ matches: q.includes('coarse') && opts.coarse, addEventListener: () => {}, removeEventListener: () => {} }),
      requestAnimationFrame: (fn: FrameRequestCallback) => frames.push(fn),
      cancelAnimationFrame: () => {},
    }) as unknown as Window;
  };

  it('leaves desktop (a fine pointer) alone', () => {
    const stop = trackVisualViewport(fakeWindow(new FakeVV(), { coarse: false }));
    expect(document.documentElement.classList.contains('vv-tracked')).toBe(false);
    stop();
  });

  it('on a phone, follows the keyboard opening and closing', () => {
    const vv = new FakeVV();
    const stop = trackVisualViewport(fakeWindow(vv, { coarse: false, platform: 'ios' }));
    const root = document.documentElement;
    expect(root.classList.contains('vv-tracked')).toBe(true);
    vv.height = 450;
    vv.dispatchEvent(new Event('resize'));
    flush();
    expect(root.classList.contains('kb-open')).toBe(true);
    expect(root.style.getPropertyValue('--app-height')).toBe('450px');
    vv.height = 800;
    vv.dispatchEvent(new Event('resize'));
    flush();
    expect(root.classList.contains('kb-open')).toBe(false);
    stop();
    expect(root.classList.contains('vv-tracked')).toBe(false);
    expect(root.style.getPropertyValue('--app-height')).toBe('');
  });
});
