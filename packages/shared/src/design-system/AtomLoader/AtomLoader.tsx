import './AtomLoader.css';

interface AtomLoaderProps {
  /** Diameter in CSS pixels. Defaults to 32px — a reasonable inline size. */
  size?: number;
  /** Extra class hooks for layout (margin, alignment) at the call site. */
  class?: string;
  /** Optional aria-label for screen readers; defaults to "Loading". */
  label?: string;
}

/**
 * Draw-on atom loader: the BosonGlyph mark draws itself orbit by orbit,
 * the nucleus pops in, it holds, then clears and repeats. Same silhouette
 * as the brand mark, so it feels native to the design language. Best for
 * indeterminate waits on a spot (a screen, a card, a button); for progress
 * along a strip use BarLoader instead.
 *
 * Pure SVG + CSS animation; no JS, no canvas, no rAF. Inherits
 * `currentColor` so callers can colour it by setting `color` on a
 * parent (matches every other icon in the design system).
 */
export function AtomLoader({ size = 32, class: className, label = 'Loading' }: AtomLoaderProps) {
  return (
    <span
      class={`bds-atom-loader ${className ?? ''}`}
      role="status"
      aria-label={label}
      style={`width: ${size}px; height: ${size}px;`}
    >
      <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <ellipse class="bds-atom-orbit bds-atom-orbit-1" pathLength="100" cx="12" cy="12" rx="10" ry="4" />
        <ellipse class="bds-atom-orbit bds-atom-orbit-2" pathLength="100" cx="12" cy="12" rx="10" ry="4" transform="rotate(60 12 12)" />
        <ellipse class="bds-atom-orbit bds-atom-orbit-3" pathLength="100" cx="12" cy="12" rx="10" ry="4" transform="rotate(120 12 12)" />
        <circle class="bds-atom-nucleus" cx="12" cy="12" r="2" fill="currentColor" stroke="none" />
      </svg>
    </span>
  );
}
