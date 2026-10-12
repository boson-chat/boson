import './ScreenshotFrame.css';

interface ScreenshotFrameProps {
  src: string;
  alt: string;
  caption?: string;
  width?: number;
  height?: number;
  loading?: 'eager' | 'lazy';
  // Cap the displayed width (CSS px) so a cropped, smaller-than-a-window
  // shot shows at its true size instead of being stretched to the column.
  maxWidth?: number;
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
  maxWidth,
}: ScreenshotFrameProps) {
  return (
    <figure class="shot-figure" style={maxWidth ? { maxWidth: `${maxWidth}px` } : undefined}>
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
