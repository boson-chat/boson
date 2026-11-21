import { useEffect, useRef, useState } from 'preact/hooks';
import { usePauseOffscreen } from '../../shared/use-offscreen';
import { Download, FileText, FileX } from 'lucide-preact';
import { Button } from '@boson/shared';
import { filesViewUrl, formatBytes, formatDuration, type FilesLink } from '../../modules/files';
import { INLINE_BOX, imagesBridge, reserveStyle, useCachedImage } from '../../shared/image-cache';
import './Uploads.css';

// A link to a network's files host, inline: an image as a thumbnail (click
// for the lightbox), video and audio as players, anything else as a card
// (name, size, expiry, download). Images come from the shell's image cache
// (desktop/imagecache.go, k=file: on disk until the file's
// X-File-Expires-At, a thumbnail inline), streamed from disk by URL;
// players stream from the shell's preview route (desktop/files.go, Range
// requests) rather than holding a whole video in memory. Both are on the
// app's own origin, so the CSP stays as it is. 404/410 → "File expired".

type Meta = { size?: number; expiresAt?: number; type?: string };
type State = { phase: 'loading' } | { phase: 'expired' } | { phase: 'error' } | { phase: 'ready'; meta: Meta; blob?: string };

function metaOf(res: Response): Meta {
  const len = Number(res.headers.get('Content-Length') ?? '');
  const range = /\/(\d+)$/.exec(res.headers.get('Content-Range') ?? '');
  const age = /max-age=(\d+)/.exec(res.headers.get('Cache-Control') ?? '');
  // X-File-Expires-At when the files host sends it, else max-age (the
  // seconds left).
  const at = Date.parse(res.headers.get('X-File-Expires-At') ?? '');
  const type = res.headers.get('X-File-Content-Type') || res.headers.get('Content-Type');
  return {
    ...(range ? { size: Number(range[1]) } : Number.isFinite(len) && len > 0 ? { size: len } : {}),
    ...(!Number.isNaN(at) ? { expiresAt: at } : age ? { expiresAt: Date.now() + Number(age[1]) * 1000 } : {}),
    ...(type ? { type } : {}),
  };
}

export function expiryLabel(expiresAt: number | undefined, now = Date.now()): string {
  if (expiresAt === undefined) return '';
  return expiresAt <= now ? 'expired' : `expires in ${formatDuration(expiresAt - now)}`;
}

export function FilesEmbed({ link, onOpenImage, openExternal }: {
  link: FilesLink;
  // Opens the lightbox on the file (its URL; the lightbox loads the full
  // image from the cache).
  onOpenImage: (url: string) => void;
  openExternal: (url: string) => void;
}) {
  // Images through the cache (when the shell has one); everything else, and
  // images without it, through the preview route as before.
  const cached = link.media === 'image' && !!imagesBridge();
  const img = useCachedImage(cached ? link.url : null, { kind: 'file', box: INLINE_BOX });
  const [state, setState] = useState<State>({ phase: 'loading' });
  const view = filesViewUrl(link.url);
  const player = useRef<HTMLVideoElement & HTMLAudioElement>(null);
  usePauseOffscreen(player);

  useEffect(() => {
    if (cached) return;
    let alive = true;
    let blob: string | null = null;
    const image = link.media === 'image';
    // Revalidated: a file taken down early must not look alive from the
    // browser's cache (the web build fetches the files host directly).
    fetch(view, { method: image ? 'GET' : 'HEAD', cache: 'no-cache' })
      .then(async (res) => {
        if (!alive) return;
        if (res.status === 404 || res.status === 410) { setState({ phase: 'expired' }); return; }
        if (!res.ok) { setState({ phase: 'error' }); return; }
        const meta = metaOf(res);
        if (image) {
          const b = await res.blob();
          if (!alive) return;
          blob = URL.createObjectURL(b);
          setState({ phase: 'ready', meta, blob });
        } else {
          setState({ phase: 'ready', meta });
        }
      })
      .catch(() => { if (alive) setState({ phase: 'error' }); });
    return () => { alive = false; if (blob) URL.revokeObjectURL(blob); };
  }, [view, link.media, cached]);

  if (cached) {
    if (img.mode === 'gone') return <ExpiredCard link={link} />;
    if (img.mode === 'error' || !img.src) return <FileCard link={link} meta={{}} phase="error" openExternal={openExternal} />;
    // Streamed from the cache's file on disk (a thumbnail); its box held at
    // the size it had last time.
    return (
      <div class="files-embed files-image" data-testid="files-embed" data-state="ready" data-media="image">
        <button type="button" class="files-image-btn" onClick={() => onOpenImage(link.url)} aria-label={`Open ${link.name}`}>
          <img src={img.src} alt={link.name} style={reserveStyle(img.dims, 280)} data-src={link.url} onLoad={img.onLoad} onError={img.onError} />
        </button>
      </div>
    );
  }

  if (state.phase === 'expired') return <ExpiredCard link={link} />;
  if (state.phase === 'loading') {
    return <div class={`files-embed files-loading files-loading-${link.media}`} data-testid="files-embed" data-state="loading" aria-label={`Loading ${link.name}`} />;
  }
  const meta = state.phase === 'ready' ? state.meta : {};
  const card = <FileCard link={link} meta={meta} phase={state.phase} openExternal={openExternal} />;
  if (state.phase !== 'ready') return card;
  if (link.media === 'image' && state.blob) {
    return (
      <div class="files-embed files-image" data-testid="files-embed" data-state="ready" data-media="image">
        <button type="button" class="files-image-btn" onClick={() => onOpenImage(link.url)} aria-label={`Open ${link.name}`}>
          <img src={state.blob} alt={link.name} />
        </button>
      </div>
    );
  }
  if (link.media === 'video') {
    return (
      <div class="files-embed files-video" data-testid="files-embed" data-state="ready" data-media="video">
        {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
        <video ref={player} src={view} controls preload="metadata" aria-label={link.name} />
        <FootLine link={link} meta={meta} openExternal={openExternal} />
      </div>
    );
  }
  if (link.media === 'audio') {
    return (
      <div class="files-embed files-audio" data-testid="files-embed" data-state="ready" data-media="audio">
        <FootLine link={link} meta={meta} openExternal={openExternal} />
        {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
        <audio ref={player} src={view} controls preload="metadata" aria-label={link.name} />
      </div>
    );
  }
  return card;
}

function ExpiredCard({ link }: { link: FilesLink }) {
  return (
    <div class="files-embed files-card files-card-expired" data-testid="files-embed" data-state="expired">
      <FileX size={20} aria-hidden="true" class="files-card-icon" />
      <span class="files-card-body">
        <span class="files-card-name">{link.name}</span>
        <span class="files-card-meta">File expired</span>
      </span>
    </div>
  );
}

function FileCard({ link, meta, phase, openExternal }: { link: FilesLink; meta: Meta; phase: string; openExternal: (url: string) => void }) {
  return (
    <div class="files-embed files-card" data-testid="files-embed" data-state={phase} data-media="file">
      <FileText size={20} aria-hidden="true" class="files-card-icon" />
      <span class="files-card-body">
        <span class="files-card-name" title={link.name}>{link.name}</span>
        <span class="files-card-meta">
          {[meta.size !== undefined ? formatBytes(meta.size) : '', expiryLabel(meta.expiresAt)].filter(Boolean).join(' · ') || link.ext.toUpperCase() || 'File'}
        </span>
      </span>
      <Button variant="secondary" size="sm" class="files-card-download" onClick={() => openExternal(link.url)} aria-label={`Download ${link.name}`}
        icon={<Download aria-hidden="true" />}>
        Download
      </Button>
    </div>
  );
}

function FootLine({ link, meta, openExternal }: { link: FilesLink; meta: Meta; openExternal: (url: string) => void }) {
  return (
    <div class="files-foot">
      <span class="files-card-name" title={link.name}>{link.name}</span>
      <span class="files-card-meta">{[meta.size !== undefined ? formatBytes(meta.size) : '', expiryLabel(meta.expiresAt)].filter(Boolean).join(' · ')}</span>
      <Button variant="ghost" size="sm" class="files-foot-download" onClick={() => openExternal(link.url)} aria-label={`Download ${link.name}`}
        icon={<Download aria-hidden="true" />} />
    </div>
  );
}
