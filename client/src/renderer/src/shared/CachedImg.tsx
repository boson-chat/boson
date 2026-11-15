import type { JSX } from 'preact';
import { reserveStyle, useCachedImage, type Box, type ImageKind } from './image-cache';

// An <img> through the image cache (shared/image-cache.ts): its src is the
// shell's disk cache (/_boson/img), or the URL itself outside the shell or
// when the shell won't serve it. Its box is reserved from the size it had
// last time (when maxHeight is given). data-src is the image's own URL,
// data-mode where it loads from (cache | direct).
export function CachedImg({
  url, kind = 'web', box, maxHeight, class: className, alt = '', loading, onClick, title,
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
}) {
  const s = useCachedImage(url, { kind, box });
  if (!s.src) return null;
  return (
    <img
      class={className}
      src={s.src}
      alt={alt}
      title={title}
      style={maxHeight ? reserveStyle(s.dims, maxHeight) : undefined}
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
