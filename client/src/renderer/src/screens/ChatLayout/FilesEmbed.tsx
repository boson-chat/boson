import { useEffect, useState } from 'preact/hooks';
import { Download, FileText, FileX } from 'lucide-preact';
import { filesViewUrl, formatBytes, formatDuration, type FilesLink } from '../../modules/files';
import './Uploads.css';

// A link to a network's files host, inline: an image as a thumbnail (click
// for the lightbox), video and audio as players, anything else as a card
// (name, size, expiry, download). Fetched through the shell's preview
// route (desktop/files.go: same origin, so the CSP stays as it is): images
// into blob: URLs; players stream from it (Range requests) rather than
// holding a whole video in memory. 404/410 → "File expired".

type Meta = { size?: number; expiresAt?: number; type?: string };
type State = { phase: 'loading' } | { phase: 'expired' } | { phase: 'error' } | { phase: 'ready'; meta: Meta; blob?: string };

function metaOf(res: Response): Meta {
  const len = Number(res.headers.get('Content-Length') ?? '');
  const range = /\/(\d+)$/.exec(res.headers.get('Content-Range') ?? '');
  const age = /max-age=(\d+)/.exec(res.headers.get('Cache-Control') ?? '');
  return {
    ...(range ? { size: Number(range[1]) } : Number.isFinite(len) && len > 0 ? { size: len } : {}),
    ...(age ? { expiresAt: Date.now() + Number(age[1]) * 1000 } : {}),
    ...(res.headers.get('Content-Type') ? { type: res.headers.get('Content-Type')! } : {}),
  };
}

export function expiryLabel(expiresAt: number | undefined, now = Date.now()): string {
  if (expiresAt === undefined) return '';
  return expiresAt <= now ? 'expired' : `expires in ${formatDuration(expiresAt - now)}`;
}

export function FilesEmbed({ link, onOpenImage, openExternal }: {
  link: FilesLink;
  onOpenImage: (src: string) => void;
  openExternal: (url: string) => void;
}) {
  const [state, setState] = useState<State>({ phase: 'loading' });
  const view = filesViewUrl(link.url);

  useEffect(() => {
    let alive = true;
    let blob: string | null = null;
    const image = link.media === 'image';
    fetch(view, { method: image ? 'GET' : 'HEAD' })
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
  }, [view, link.media]);

  if (state.phase === 'expired') {
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
  if (state.phase === 'loading') {
    return <div class={`files-embed files-loading files-loading-${link.media}`} data-testid="files-embed" data-state="loading" aria-label={`Loading ${link.name}`} />;
  }
  const meta = state.phase === 'ready' ? state.meta : {};
  const card = (
    <div class="files-embed files-card" data-testid="files-embed" data-state={state.phase} data-media="file">
      <FileText size={20} aria-hidden="true" class="files-card-icon" />
      <span class="files-card-body">
        <span class="files-card-name" title={link.name}>{link.name}</span>
        <span class="files-card-meta">
          {[meta.size !== undefined ? formatBytes(meta.size) : '', expiryLabel(meta.expiresAt)].filter(Boolean).join(' · ') || link.ext.toUpperCase() || 'File'}
        </span>
      </span>
      <button type="button" class="files-card-download" onClick={() => openExternal(link.url)} aria-label={`Download ${link.name}`}>
        <Download size={16} aria-hidden="true" /> Download
      </button>
    </div>
  );
  if (state.phase !== 'ready') return card;
  if (link.media === 'image' && state.blob) {
    return (
      <div class="files-embed files-image" data-testid="files-embed" data-state="ready" data-media="image">
        <button type="button" class="files-image-btn" onClick={() => onOpenImage(state.blob!)} aria-label={`Open ${link.name}`}>
          <img src={state.blob} alt={link.name} />
        </button>
      </div>
    );
  }
  if (link.media === 'video') {
    return (
      <div class="files-embed files-video" data-testid="files-embed" data-state="ready" data-media="video">
        {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
        <video src={view} controls preload="metadata" aria-label={link.name} />
        <FootLine link={link} meta={meta} openExternal={openExternal} />
      </div>
    );
  }
  if (link.media === 'audio') {
    return (
      <div class="files-embed files-audio" data-testid="files-embed" data-state="ready" data-media="audio">
        <FootLine link={link} meta={meta} openExternal={openExternal} />
        {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
        <audio src={view} controls preload="metadata" aria-label={link.name} />
      </div>
    );
  }
  return card;
}

function FootLine({ link, meta, openExternal }: { link: FilesLink; meta: Meta; openExternal: (url: string) => void }) {
  return (
    <div class="files-foot">
      <span class="files-card-name" title={link.name}>{link.name}</span>
      <span class="files-card-meta">{[meta.size !== undefined ? formatBytes(meta.size) : '', expiryLabel(meta.expiresAt)].filter(Boolean).join(' · ')}</span>
      <button type="button" class="files-foot-download" onClick={() => openExternal(link.url)} aria-label={`Download ${link.name}`}>
        <Download size={14} aria-hidden="true" />
      </button>
    </div>
  );
}
