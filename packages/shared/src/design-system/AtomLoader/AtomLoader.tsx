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
 * Animated three-orbit atom — same silhouette as the BosonGlyph mark
 * the rest of the app uses for branding, so the loader feels native to
 * the design language. The nucleus pulses, each orbit rotates at a
 * different rate to suggest motion without being dizzying.
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
      <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <circle class="bds-atom-nucleus" cx="12" cy="12" r="2" fill="currentColor" stroke="none" />
        <ellipse class="bds-atom-orbit bds-atom-orbit-1" cx="12" cy="12" rx="10" ry="4" />
        <ellipse class="bds-atom-orbit bds-atom-orbit-2" cx="12" cy="12" rx="10" ry="4" />
        <ellipse class="bds-atom-orbit bds-atom-orbit-3" cx="12" cy="12" rx="10" ry="4" />
      </svg>
    </span>
  );
}
