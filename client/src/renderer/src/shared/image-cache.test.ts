import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { h } from 'preact';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/preact';
import {
  clearImagesForSignOut, DIMS_STORAGE_KEY, fitWithin, forgetDims, frameStyle, GUESS_BOX, imageCacheUrl, knownDims,
  reloadDimsForTest, rememberDims, reserveStyle, saveDimsNow, useCachedImage, videoStyle, type CachedImageState,
} from './image-cache';
import { CachedImg, FrameView, ImageFrame } from './CachedImg';
import { clearEmbedMemo, memoFetch, memoGet } from './embed-memo';

const bridge = () => ({ route: '/_boson/img', stats: vi.fn(), setLimitMB: vi.fn(), clear: vi.fn() });

describe('imageCacheUrl / reserveStyle / dims', () => {
  afterEach(() => { delete window.bosonImages; forgetDims(); });
  it('is null outside the shell', () => {
    expect(imageCacheUrl('https://x/a.png', 'web')).toBeNull();
  });
  it('names the kind, the URL and the box', () => {
    window.bosonImages = bridge();
    expect(imageCacheUrl('https://x/a.png?b=1', 'web', { w: 10, h: 20 })).toBe('/_boson/img?k=web&u=https%3A%2F%2Fx%2Fa.png%3Fb%3D1&w=10&h=20');
    expect(imageCacheUrl('https://f/f/abc/x.png', 'file')).toBe('/_boson/img?k=file&u=https%3A%2F%2Ff%2Ff%2Fabc%2Fx.png');
  });
  it('reserves an aspect-ratio box under a max height', () => {
    expect(reserveStyle({ w: 1600, h: 1000 }, 280)).toBe('width:448px;aspect-ratio:1600 / 1000;height:auto');
    expect(reserveStyle({ w: 100, h: 50 }, 280)).toBe('width:100px;aspect-ratio:100 / 50;height:auto');
    expect(reserveStyle(undefined, 280)).toBeUndefined();
  });
  it('remembers sizes, a bounded number of them, oldest out first', () => {
    for (let i = 0; i < 5001; i++) rememberDims(`u${i}`, { w: i + 1, h: 1 });
    expect(knownDims('u0')).toBeUndefined();
    expect(knownDims('u5000')).toEqual({ w: 5001, h: 1 });
    rememberDims('bad', { w: 0, h: 10 });
    expect(knownDims('bad')).toBeUndefined();
  });
});

describe('useCachedImage', () => {
  let last: CachedImageState | null = null;
  function Probe({ url, kind = 'web', probe }: { url: string; kind?: 'web' | 'file'; probe?: (s: string) => Promise<number> }) {
    last = useCachedImage(url, { kind, box: { w: 100, h: 100 }, probe });
    return null;
  }
  beforeEach(() => { last = null; window.bosonImages = bridge(); });
  afterEach(() => { cleanup(); delete window.bosonImages; forgetDims(); });

  it('points at the shell\'s cache route (no bytes in the page)', () => {
    render(h(Probe, { url: 'https://x/a.png' }));
    expect(last).toMatchObject({ mode: 'cache', src: '/_boson/img?k=web&u=https%3A%2F%2Fx%2Fa.png&w=100&h=100' });
  });

  it('is the URL itself outside the shell', () => {
    delete window.bosonImages;
    render(h(Probe, { url: 'https://x/a.png' }));
    expect(last).toMatchObject({ mode: 'direct', src: 'https://x/a.png' });
  });

  it('a failed web image falls back to its URL; a gone one (404/410) is gone', async () => {
    render(h(Probe, { url: 'https://x/private.png', probe: async () => 403 }));
    last!.onError();
    await waitFor(() => expect(last).toMatchObject({ mode: 'direct', src: 'https://x/private.png' }));
    last!.onError(); // and that fails too
    await waitFor(() => expect(last).toMatchObject({ mode: 'error', src: null }));
    cleanup();
    render(h(Probe, { url: 'https://x/gone.png', probe: async () => 410 }));
    last!.onError();
    await waitFor(() => expect(last).toMatchObject({ mode: 'gone', src: null }));
  });

  it('a file never falls back to its URL', async () => {
    render(h(Probe, { url: 'https://files/f/abc/x.png', kind: 'file', probe: async () => 502 }));
    last!.onError();
    await waitFor(() => expect(last).toMatchObject({ mode: 'error', src: null }));
  });
});

describe('CachedImg', () => {
  afterEach(() => { cleanup(); delete window.bosonImages; forgetDims(); });
  it('learns the size when it loads, and reserves it the next time', () => {
    window.bosonImages = bridge();
    const first = render(h(CachedImg, { url: 'https://x/a.png', class: 'embed-img', maxHeight: 280 }));
    const img = first.container.querySelector('img')!;
    expect(img.getAttribute('src')).toBe('/_boson/img?k=web&u=https%3A%2F%2Fx%2Fa.png');
    expect(img.getAttribute('data-src')).toBe('https://x/a.png');
    expect(img.getAttribute('style')).toBeNull();
    Object.defineProperty(img, 'naturalWidth', { value: 800 });
    Object.defineProperty(img, 'naturalHeight', { value: 400 });
    fireEvent.load(img);
    first.unmount();
    const again = render(h(CachedImg, { url: 'https://x/a.png', class: 'embed-img', maxHeight: 280 }));
    const img2 = again.container.querySelector('img')!;
    expect(img2.style.width).toBe('560px');
    expect(img2.style.aspectRatio).toBe('800 / 400');
  });
});

describe('clearImagesForSignOut', () => {
  afterEach(() => { delete window.bosonImages; forgetDims(); });
  it("empties the shell's disk cache and the known sizes", async () => {
    const b = bridge();
    window.bosonImages = b;
    rememberDims('https://files.example/f/secret.png', { w: 10, h: 10 });
    await clearImagesForSignOut();
    expect(b.clear).toHaveBeenCalledOnce();
    expect(knownDims('https://files.example/f/secret.png')).toBeUndefined();
  });
  it('is fine outside the shell', async () => {
    await expect(clearImagesForSignOut()).resolves.toBeUndefined();
  });
  it('forgets the sizes kept in storage too', async () => {
    rememberDims('https://files.example/f/secret.png', { w: 10, h: 10 });
    saveDimsNow();
    expect(localStorage.getItem(DIMS_STORAGE_KEY)).toContain('secret.png');
    await clearImagesForSignOut();
    expect(localStorage.getItem(DIMS_STORAGE_KEY)).toBeNull();
    reloadDimsForTest();
    expect(knownDims('https://files.example/f/secret.png')).toBeUndefined();
  });
});

describe('known sizes across restarts', () => {
  afterEach(() => { forgetDims(); localStorage.clear(); });
  it('kept in storage and read back (a restart)', () => {
    rememberDims('https://x/a.png', { w: 800, h: 600 });
    rememberDims('https://x/b.png', { w: 30, h: 90 });
    saveDimsNow();
    reloadDimsForTest();
    expect(knownDims('https://x/a.png')).toEqual({ w: 800, h: 600 });
    expect(knownDims('https://x/b.png')).toEqual({ w: 30, h: 90 });
  });
  it('written a moment after the last change, not on every image', () => {
    vi.useFakeTimers();
    try {
      rememberDims('https://x/a.png', { w: 1, h: 2 });
      expect(localStorage.getItem(DIMS_STORAGE_KEY)).toBeNull();
      vi.advanceTimersByTime(1100);
      expect(JSON.parse(localStorage.getItem(DIMS_STORAGE_KEY)!)).toEqual([['https://x/a.png', 1, 2]]);
    } finally {
      vi.useRealTimers();
    }
  });
  it('keeps only the most recent ones in storage', () => {
    for (let i = 0; i < 1600; i++) rememberDims(`https://x/${i}.png`, { w: 10, h: 10 });
    saveDimsNow();
    const rows = JSON.parse(localStorage.getItem(DIMS_STORAGE_KEY)!) as unknown[][];
    expect(rows).toHaveLength(1500);
    expect(rows[0]![0]).toBe('https://x/100.png');
    expect(rows[1499]![0]).toBe('https://x/1599.png');
  });
  it('a used size moves to the newest end (it outlives the cap)', () => {
    rememberDims('https://x/old.png', { w: 5, h: 5 });
    for (let i = 0; i < 1499; i++) rememberDims(`https://x/${i}.png`, { w: 10, h: 10 });
    rememberDims('https://x/old.png', { w: 6, h: 5 });
    rememberDims('https://x/one-more.png', { w: 10, h: 10 });
    saveDimsNow();
    const urls = (JSON.parse(localStorage.getItem(DIMS_STORAGE_KEY)!) as unknown[][]).map((r) => r[0]);
    expect(urls).toContain('https://x/old.png');
    expect(urls).not.toContain('https://x/0.png');
  });
  it('ignores what it can\'t read', () => {
    localStorage.setItem(DIMS_STORAGE_KEY, '{not json');
    reloadDimsForTest();
    expect(knownDims('https://x/a.png')).toBeUndefined();
    localStorage.setItem(DIMS_STORAGE_KEY, JSON.stringify([['https://x/a.png', 0, 5], ['https://x/b.png', 4, 3], [7, 1, 1], 'x']));
    reloadDimsForTest();
    expect(knownDims('https://x/a.png')).toBeUndefined();
    expect(knownDims('https://x/b.png')).toEqual({ w: 4, h: 3 });
  });
});

describe('sizing an image before it loads', () => {
  it('fits inside a box, never scaling up', () => {
    expect(fitWithin({ w: 1600, h: 1000 }, 420, 280)).toEqual({ w: 420, h: 263 });
    expect(fitWithin({ w: 400, h: 900 }, 420, 280)).toEqual({ w: 124, h: 280 });
    expect(fitWithin({ w: 80, h: 60 }, 420, 280)).toEqual({ w: 80, h: 60 });
  });
  it('a known size: its width and aspect ratio (scales down evenly in a narrow column)', () => {
    expect(frameStyle({ w: 1600, h: 1000 }, 420, 280)).toBe('width:420px;aspect-ratio:1600 / 1000');
    expect(frameStyle({ w: 400, h: 900 }, 420, 280)).toBe('width:124px;aspect-ratio:400 / 900');
    expect(frameStyle({ w: 80, h: 60 }, 420, 280)).toBe('width:80px;aspect-ratio:80 / 60');
  });
  it('an unknown size: a fixed guess box', () => {
    expect(frameStyle(undefined, 420, 280)).toBe(`width:${GUESS_BOX.w}px;height:${GUESS_BOX.h}px`);
    expect(frameStyle(undefined, 200, 100)).toBe('width:200px;height:100px');
  });
  it('a video: its size last time, else 16:9', () => {
    expect(videoStyle(undefined, 360)).toBe('width:min(100%, 640px);aspect-ratio:16 / 9');
    expect(videoStyle({ w: 720, h: 1280 }, 360)).toBe('width:min(100%, 203px);aspect-ratio:720 / 1280');
  });
});

describe('ImageFrame', () => {
  afterEach(() => { cleanup(); forgetDims(); localStorage.clear(); });
  const load = (img: HTMLImageElement, w: number, hh: number): void => {
    Object.defineProperty(img, 'naturalWidth', { value: w });
    Object.defineProperty(img, 'naturalHeight', { value: hh });
    fireEvent.load(img);
  };

  it('unknown size: a guess box with a shimmer, whose height stays when the image lands', () => {
    const r = render(h(ImageFrame, { url: 'https://x/new.png', imgClass: 'embed-img' }));
    const frame = r.container.querySelector<HTMLElement>('.img-frame')!;
    expect(frame.dataset['state']).toBe('loading');
    expect(frame.dataset['reserved']).toBe('guess');
    expect(frame.style.height).toBe('240px');
    expect(frame.querySelector('[role="progressbar"]')).not.toBeNull();
    const img = frame.querySelector<HTMLImageElement>('img.img-frame-img.embed-img')!;
    load(img, 400, 900);
    expect(frame.dataset['state']).toBe('loaded');
    expect(frame.style.height).toBe('240px'); // unchanged
    expect(frame.style.width).toBe('107px'); // narrowed to the image
    expect(frame.querySelector('[role="progressbar"]')).toBeNull();
    // Learnt for next time.
    expect(knownDims('https://x/new.png')).toEqual({ w: 400, h: 900 });
  });

  it('known size: reserved exactly, from the first frame', () => {
    rememberDims('https://x/seen.png', { w: 1200, h: 800 });
    const r = render(h(ImageFrame, { url: 'https://x/seen.png' }));
    const frame = r.container.querySelector<HTMLElement>('.img-frame')!;
    expect(frame.dataset['reserved']).toBe('known');
    expect(frame.style.width).toBe('420px');
    expect(frame.style.aspectRatio).toBe('1200 / 800');
  });

  it('a size learnt while it shows does not resize it', () => {
    const r = render(h(ImageFrame, { url: 'https://x/twice.png' }));
    rememberDims('https://x/twice.png', { w: 100, h: 100 }); // the same URL, loaded elsewhere
    r.rerender(h(ImageFrame, { url: 'https://x/twice.png' }));
    expect(r.container.querySelector<HTMLElement>('.img-frame')!.style.height).toBe('240px');
  });

  it('a failed image keeps its box and says so', () => {
    const r = render(h(FrameView, { url: 'https://x/broken.png', src: 'https://x/broken.png', failed: true }));
    const frame = r.container.querySelector<HTMLElement>('.img-frame')!;
    expect(frame.dataset['state']).toBe('error');
    expect(frame.style.height).toBe('240px');
    expect(frame.textContent).toContain('Image unavailable');
  });
});

describe('embed memo', () => {
  afterEach(() => clearEmbedMemo());
  it('remembers what a fetch answered, by kind and URL (null too)', async () => {
    const f = vi.fn(async (u: string) => (u.endsWith('a') ? { t: 1 } : null));
    expect(memoGet('unfurl', 'https://x/a')).toBeUndefined();
    await memoFetch('unfurl', 'https://x/a', f);
    await memoFetch('unfurl', 'https://x/b', f);
    expect(memoGet('unfurl', 'https://x/a')).toEqual({ t: 1 });
    expect(memoGet('unfurl', 'https://x/b')).toBeNull();
    expect(memoGet('spotify', 'https://x/a')).toBeUndefined();
    clearEmbedMemo();
    expect(memoGet('unfurl', 'https://x/a')).toBeUndefined();
  });
});
