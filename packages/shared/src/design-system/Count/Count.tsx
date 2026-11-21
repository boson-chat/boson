import './Count.css';

export type CountTone = 'accent' | 'danger' | 'neutral';

interface CountProps {
  /** The number. 0 renders nothing. */
  value: number;
  tone?: CountTone;
  /** Above this it shows "max+". Default 99. */
  max?: number;
  /** md 18px (default) · sm 16px (the desktop title bar). */
  size?: 'sm' | 'md';
  /**
   * Pinned over a tile or an icon: a ring in the surface colour behind it
   * keeps it apart from what it sits on (set --count-ring to that colour).
   */
  overlay?: boolean;
  /** Spoken instead of the bare number ("3 unread mentions"). */
  label?: string;
  /** Layout hook (position) for the call site. */
  class?: string;
}

// An unread / mention / missed count: one small rounded square with a
// number in it, everywhere a count is shown (rail, MY, sidebar, tabs, the
// title bar's bell).
export function Count({ value, tone = 'accent', max = 99, size = 'md', overlay = false, label, class: extra }: CountProps) {
  if (!value || value < 0) return null;
  const text = value > max ? `${max}+` : String(value);
  const cls = ['bds-count', `bds-count-${tone}`, `bds-count-${size}`, overlay ? 'bds-count-overlay' : '', extra ?? '']
    .filter(Boolean).join(' ');
  return (
    <span class={cls} aria-label={label} role={label ? 'img' : undefined}>
      {text}
    </span>
  );
}
