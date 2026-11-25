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
//
// Learnt when an image loads; kept in memory (MAX_DIMS) and, the most
// recent PERSIST_DIMS of them, in localStorage, so a conversation's history
// shown again after a restart lays its images out at their size at once.

const MAX_DIMS = 5000;
const PERSIST_DIMS = 1500;
export const DIMS_STORAGE_KEY = 'boson:image-dims:v1';
// Map order = insertion order: the oldest go first past the cap.
const dimsByUrl = new Map<string, Box>();
let dimsLoaded = false;
let saveTimer: ReturnType<typeof setTimeout> | null = null;

function dimsStore(): Storage | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null;
  }
}

function loadDims(): void {
  if (dimsLoaded) return;
  dimsLoaded = true;
  try {
    const raw = dimsStore()?.getItem(DIMS_STORAGE_KEY);
    if (!raw) return;
    const rows = JSON.parse(raw) as unknown;
    if (!Array.isArray(rows)) return;
    for (const r of rows) {
      if (!Array.isArray(r) || typeof r[0] !== 'string') continue;
      const w = Number(r[1]);
      const h = Number(r[2]);
      if (w > 0 && h > 0 && !dimsByUrl.has(r[0])) dimsByUrl.set(r[0], { w, h });
    }
  } catch {
    // Unreadable: start empty.
  }
}

// Written a moment after the last change (images load in bursts).
function scheduleSave(): void {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    saveDimsNow();
  }, 1000);
}

export function saveDimsNow(): void {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  const s = dimsStore();
  if (!s) return;
  const all = Array.from(dimsByUrl.entries());
  const rows = all.slice(Math.max(0, all.length - PERSIST_DIMS)).map(([u, b]) => [u, b.w, b.h]);
  try {
    if (rows.length === 0) s.removeItem(DIMS_STORAGE_KEY);
    else s.setItem(DIMS_STORAGE_KEY, JSON.stringify(rows));
  } catch {
    // Full or blocked: the sizes stay in memory.
  }
}

// Sign-out: empty the shell's image cache (avatars, link previews, uploaded
// files' previews from this account's conversations) and the known sizes.
export async function clearImagesForSignOut(): Promise<void> {
  forgetDims();
  await imagesBridge()?.clear();
}

export function knownDims(url: string): Box | undefined {
  loadDims();
  return dimsByUrl.get(url);
}

export function rememberDims(url: string, box: Box): void {
  if (!(box.w > 0 && box.h > 0)) return;
  loadDims();
  const have = dimsByUrl.get(url);
  if (have && have.w === box.w && have.h === box.h) return;
  dimsByUrl.delete(url);
  dimsByUrl.set(url, { w: box.w, h: box.h });
  while (dimsByUrl.size > MAX_DIMS) dimsByUrl.delete(dimsByUrl.keys().next().value!);
  scheduleSave();
}

export function forgetDims(): void {
  dimsByUrl.clear();
  dimsLoaded = true;
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  try { dimsStore()?.removeItem(DIMS_STORAGE_KEY); } catch { /* blocked */ }
}

// Tests: drop the in-memory copy, so the next read loads from storage.
export function reloadDimsForTest(): void {
  dimsByUrl.clear();
  dimsLoaded = false;
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
}

// ---- an image's box before it loads ----

// The box an image of unknown size gets while it loads (and keeps: once
// it's in, only the frame's width follows the image, never its height).
export const GUESS_BOX: Box = { w: 320, h: 240 };

// The size an image of `natural` size is shown at inside maxW × maxH,
// never scaled up.
export function fitWithin(natural: Box, maxW: number, maxH: number): Box {
  const s = Math.min(1, maxW / natural.w, maxH / natural.h);
  return { w: Math.max(1, Math.round(natural.w * s)), h: Math.max(1, Math.round(natural.h * s)) };
}

// An image frame's inline style, decided before the image loads: its size
// last time when that's known (a width and an aspect ratio, so a narrower
// column scales it down evenly), else GUESS_BOX (a fixed height the image
// is fitted into). Either way the height doesn't change when it lands.
export function frameStyle(dims: Box | undefined, maxW: number, maxH: number): string {
  if (!dims) return `width:${Math.min(GUESS_BOX.w, maxW)}px;height:${Math.min(GUESS_BOX.h, maxH)}px`;
  const fit = fitWithin(dims, maxW, maxH);
  return `width:${fit.w}px;aspect-ratio:${dims.w} / ${dims.h}`;
}

// A video's box before its metadata: its size last time, else 16:9; as
// wide as the column allows under maxH.
export function videoStyle(dims: Box | undefined, maxH: number): string {
  const d = dims ?? { w: 16, h: 9 };
  return `width:min(100%, ${Math.round((maxH * d.w) / d.h)}px);aspect-ratio:${d.w} / ${d.h}`;
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
