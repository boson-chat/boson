// The renderer's side of the image cache.
//
// In the desktop app every image (link embeds and their cards, avatars,
// network theme images, uploaded files' previews) is an <img> whose src is
// the shell's on-disk cache, /_boson/img?k=<kind>&u=<url> on the app's own
// origin (desktop/imagecache.go): fresh from disk, revalidated when stale,
// or fetched — the bytes stream from the cache file to the webview and
// never sit in the JS heap. Inline previews ask for a thumbnail (&w=&h=),
// which the shell scales down once and keeps on disk; the lightbox asks
// for the full image.
//
// The one thing kept here is each image's size (a couple of numbers per
// URL, capped), learnt when it loads, so its box is laid out before it
// decodes the next time — no layout shift when it lands.
//
// Outside the shell (a browser, tests) there is no /_boson/img: images load
// straight from their URL, as before.
import { useRef, useState } from 'preact/hooks';

export type ImageKind = 'web' | 'theme' | 'file';

// The inline thumbnail box: 2× the inline maximum (Embed.css: max-height
// 280px; message column ~640px), so it's sharp on a retina screen.
export const INLINE_BOX = { w: 1280, h: 560 } as const;

export interface ImagesBridge {
  route: string;
  stats(): Promise<ImageCacheStats>;
  setLimitMB(mb: number): Promise<ImageCacheStats>;
  clear(): Promise<ImageCacheStats>;
}

export interface ImageCacheStats {
  usedBytes: number;
  limitBytes: number;
  entries: number;
  error?: string;
}

declare global {
  interface Window {
    bosonImages?: ImagesBridge;
  }
}

export function imagesBridge(): ImagesBridge | null {
  return (typeof window !== 'undefined' ? window.bosonImages : undefined) ?? null;
}

export interface Box { w: number; h: number }

// Where the shell serves url from (null outside the shell).
export function imageCacheUrl(url: string, kind: ImageKind, box?: Box | null): string | null {
  const bridge = imagesBridge();
  if (!bridge) return null;
  const q = new URLSearchParams({ k: kind, u: url });
  if (box) {
    q.set('w', String(box.w));
    q.set('h', String(box.h));
  }
  return `${bridge.route}?${q.toString()}`;
}

// ---- known sizes ----

const MAX_DIMS = 5000;
// Map order = insertion order: the oldest go first past the cap.
const dimsByUrl = new Map<string, Box>();

export function knownDims(url: string): Box | undefined {
  return dimsByUrl.get(url);
}

export function rememberDims(url: string, box: Box): void {
  if (!(box.w > 0 && box.h > 0)) return;
  const have = dimsByUrl.get(url);
  if (have && have.w === box.w && have.h === box.h) return;
  dimsByUrl.delete(url);
  dimsByUrl.set(url, box);
  while (dimsByUrl.size > MAX_DIMS) dimsByUrl.delete(dimsByUrl.keys().next().value!);
}

export function forgetDims(): void {
  dimsByUrl.clear();
}

// Inline size for an image of `dims` under a max height (CSS keeps
// max-width: 100%): an aspect ratio and a width, so its box is reserved
// before it decodes.
export function reserveStyle(dims: Box | undefined, maxHeight: number): string | undefined {
  if (!dims) return undefined;
  const w = Math.min(dims.w, (maxHeight * dims.w) / dims.h);
  return `width:${Math.round(w)}px;aspect-ratio:${dims.w} / ${dims.h};height:auto`;
}

// ---- the hook ----

export type ImageMode = 'cache' | 'direct' | 'gone' | 'error';

export interface CachedImageState {
  mode: ImageMode;
  // What the <img> loads (null: nothing to show).
  src: string | null;
  dims?: Box;
  // Wire to the <img>.
  onLoad: (e: Event) => void;
  onError: () => void;
}

export interface UseCachedImageOptions {
  kind: ImageKind;
  box?: Box | null;
  // Web images the shell won't serve (a private host, too big, an odd
  // format) are tried straight from their URL, as before. Files can't be.
  fallbackDirect?: boolean;
  // Asks for a failure's status (404/410 → gone); tests stub it.
  probe?: (src: string) => Promise<number>;
}

const headStatus = (src: string): Promise<number> =>
  fetch(src, { method: 'HEAD' }).then((r) => r.status, () => 0);

// An image through the cache: its src, its known size, and what to do when
// it fails (the files host said it's gone; or fall back to the URL).
export function useCachedImage(url: string | null | undefined, opts: UseCachedImageOptions): CachedImageState {
  const { kind, box } = opts;
  const fallback = opts.fallbackDirect ?? kind !== 'file';
  const cacheSrc = url ? imageCacheUrl(url, kind, box) : null;
  const key = `${kind} ${url ?? ''} ${box ? `${box.w}x${box.h}` : ''}`;
  const initialMode = (): ImageMode => (!url ? 'error' : cacheSrc ? 'cache' : 'direct');
  const [mode, setMode] = useState<ImageMode>(initialMode);
  const shown = useRef(key);
  let current = mode;
  if (shown.current !== key) {
    shown.current = key;
    current = initialMode();
    setMode(current);
  }
  const src = current === 'cache' ? cacheSrc : current === 'direct' ? url ?? null : null;
  return {
    mode: current,
    src,
    dims: url ? knownDims(url) : undefined,
    onLoad: (e: Event) => {
      const img = e.currentTarget as HTMLImageElement | null;
      if (url && img?.naturalWidth && img.naturalHeight) rememberDims(url, { w: img.naturalWidth, h: img.naturalHeight });
    },
    onError: () => {
      if (current === 'direct') { setMode('error'); return; }
      if (current !== 'cache' || !cacheSrc) return;
      const at = key;
      void (opts.probe ?? headStatus)(cacheSrc).then((status) => {
        if (shown.current !== at) return;
        if (status === 404 || status === 410) setMode('gone');
        else setMode(fallback ? 'direct' : 'error');
      });
    },
  };
}
