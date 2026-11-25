import type { JSX } from 'preact';
import { useState } from 'preact/hooks';
import { BarLoader } from '@boson/shared';
import {
  GUESS_BOX, fitWithin, frameStyle, rememberDims, reserveStyle, useCachedImage,
  type Box, type CachedImageState, type ImageKind,
} from './image-cache';
import './CachedImg.css';

// An <img> through the image cache (shared/image-cache.ts): its src is the
// shell's disk cache (/_boson/img), or the URL itself outside the shell or
// when the shell won't serve it. Its box is reserved from the size it had
// last time (when maxHeight is given). data-src is the image's own URL,
// data-mode where it loads from (cache | direct).
export function CachedImg({
  url, kind = 'web', box, maxHeight, class: className, alt = '', loading, onClick, title, style,
}: {
  url: string;
  kind?: ImageKind;
  box?: Box | null;
  maxHeight?: number;
  class?: string;
  alt?: string;
  loading?: 'lazy' | 'eager';
  onClick?: JSX.MouseEventHandler<HTMLImageElement>;
  title?: string;
  // A box the caller reserves itself (overrides maxHeight's).
  style?: string;
}) {
  const s = useCachedImage(url, { kind, box });
  if (!s.src) return null;
  return (
    <img
      class={className}
      src={s.src}
      alt={alt}
      title={title}
      style={style ?? (maxHeight ? reserveStyle(s.dims, maxHeight) : undefined)}
      loading={loading}
      decoding="async"
      data-mode={s.mode}
      data-src={url}
      onLoad={s.onLoad}
      onError={s.onError}
      onClick={onClick}
    />
  );
}

// An inline image in a frame whose size is fixed before the image loads
// (image-cache.ts frameStyle): the size it had last time, else a guess the
// image is then fitted into. A shimmer runs along its foot until it's in.
// Nothing around it moves when it lands (the frame's height never changes;
// a guessed frame narrows to the image's width).
export function ImageFrame({
  url, kind = 'web', box, maxWidth = 420, maxHeight = 280, class: className, imgClass, alt = '', state,
}: {
  url: string;
  kind?: ImageKind;
  box?: Box | null;
  maxWidth?: number;
  maxHeight?: number;
  class?: string;
  // The <img>'s own class (besides img-frame-img).
  imgClass?: string;
  alt?: string;
  // The image's state from the caller's own useCachedImage (FilesEmbed
  // acts on its failures); else the frame loads it itself.
  state?: CachedImageState;
}) {
  const own = useCachedImage(state ? null : url, { kind, box });
  const s = state ?? own;
  return <FrameView url={url} src={s.src} dims={s.dims} mode={s.mode} onLoad={s.onLoad} onError={s.onError}
    maxWidth={maxWidth} maxHeight={maxHeight} class={className} imgClass={imgClass} alt={alt} key={url} />;
}

// The frame itself, for any src (a blob too). `failed`: it won't load.
export function FrameView({
  url, src, dims, mode, onLoad, onError, maxWidth = 420, maxHeight = 280, class: className, imgClass, alt = '', failed,
}: {
  url: string;
  src: string | null;
  dims?: Box;
  mode?: string;
  onLoad?: (e: Event) => void;
  onError?: () => void;
  maxWidth?: number;
  maxHeight?: number;
  class?: string;
  imgClass?: string;
  alt?: string;
  failed?: boolean;
}) {
  // Decided once, when the frame first shows: a size learnt while it's on
  // screen must not resize it.
  const [initial] = useState(() => dims);
  const [loaded, setLoaded] = useState(false);
  const [fitWidth, setFitWidth] = useState<number | null>(null);
  const broken = failed || mode === 'error' || mode === 'gone';
  const phase = broken ? 'error' : loaded ? 'loaded' : 'loading';
  let style = frameStyle(initial, maxWidth, maxHeight);
  if (fitWidth !== null) style += `;width:${fitWidth}px`;
  return (
    <span class={`img-frame${className ? ` ${className}` : ''}`} data-state={phase} data-reserved={initial ? 'known' : 'guess'} style={style}>
      {src && !broken && (
        <img
          class={`img-frame-img${imgClass ? ` ${imgClass}` : ''}`}
          src={src}
          alt={alt}
          decoding="async"
          data-mode={mode}
          data-src={url}
          onLoad={(e) => {
            onLoad?.(e);
            const img = e.currentTarget as HTMLImageElement;
            const natural = img.naturalWidth && img.naturalHeight ? { w: img.naturalWidth, h: img.naturalHeight } : null;
            if (natural) rememberDims(url, natural);
            // A guessed frame keeps its height and takes the image's width.
            if (!initial && natural) {
              const h = Math.min(maxHeight, GUESS_BOX.h);
              setFitWidth(Math.max(48, fitWithin(natural, maxWidth, h).w));
            }
            setLoaded(true);
          }}
          onError={() => onError?.()}
        />
      )}
      {phase === 'loading' && <BarLoader class="img-frame-bar" label="Loading image" />}
      {phase === 'error' && <span class="img-frame-error">Image unavailable</span>}
    </span>
  );
}
