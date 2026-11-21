import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { h } from 'preact';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/preact';
import {
  clearImagesForSignOut, forgetDims, imageCacheUrl, knownDims, rememberDims, reserveStyle, useCachedImage, type CachedImageState,
} from './image-cache';
import { CachedImg } from './CachedImg';

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
});
