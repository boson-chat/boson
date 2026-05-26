import './ScreenshotFrame.css';

interface ScreenshotFrameProps {
  src: string;
  alt: string;
  caption?: string;
  width?: number;
  height?: number;
  loading?: 'eager' | 'lazy';
}

/**
 * A "macOS window" frame for product screenshots. The bar with the three
 * traffic-light dots is rendered via CSS so we don't need to commit any
 * decorative bitmaps.
 */
export function ScreenshotFrame({
  src,
  alt,
  caption,
  width,
  height,
  loading = 'lazy',
}: ScreenshotFrameProps) {
  return (
    <figure class="shot-figure">
      <div class="shot shot-window">
        <img
          src={src}
          alt={alt}
          width={width}
          height={height}
          loading={loading}
          decoding="async"
        />
      </div>
      {caption ? <span class="shot-caption">{caption}</span> : null}
    </figure>
  );
}
