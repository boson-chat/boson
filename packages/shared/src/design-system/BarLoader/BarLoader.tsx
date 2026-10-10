import './BarLoader.css';

interface BarLoaderProps {
  /** Determinate progress, 0–100. Omit for an indeterminate shimmer. */
  value?: number;
  /** Bar thickness in CSS pixels. Defaults to 2px — a hairline for edges. */
  height?: number;
  /** Extra class hooks for layout (positioning on an edge, margins). */
  class?: string;
  /** Accessible name; defaults to "Loading". */
  label?: string;
}

/**
 * Thin progress bar for waits that happen along an edge while content stays
 * visible: a list refetching, older history loading in, a connecting strip.
 * For a wait on a spot (empty screen, button, card) use AtomLoader instead.
 *
 * Indeterminate (no `value`): a soft wave of light moves across a faint
 * track. Determinate (`value` 0–100): the track fills to that point.
 *
 * Pure CSS; inherits `currentColor` like every icon in the design system, so
 * callers colour it by setting `color` on the bar or a parent.
 */
export function BarLoader({ value, height = 2, class: className, label = 'Loading' }: BarLoaderProps) {
  const determinate = typeof value === 'number' && Number.isFinite(value);
  const pct = determinate ? Math.min(100, Math.max(0, value)) : 0;
  return (
    <div
      class={`bds-bar-loader ${className ?? ''}`}
      role="progressbar"
      aria-label={label}
      aria-valuemin={determinate ? 0 : undefined}
      aria-valuemax={determinate ? 100 : undefined}
      aria-valuenow={determinate ? Math.round(pct) : undefined}
      data-mode={determinate ? 'determinate' : 'indeterminate'}
      style={`height: ${height}px;${determinate ? ` --bds-bar-value: ${pct}%;` : ''}`}
    >
      <span class="bds-bar-loader-fill" />
    </div>
  );
}
