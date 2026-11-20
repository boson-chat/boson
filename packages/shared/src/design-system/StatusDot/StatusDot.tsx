import './StatusDot.css';

// online / live: green · dnd / error: red · away: amber · offline: grey ·
// unread: the quiet "something new" dot · accent: an update, a new item.
export type DotStatus = 'online' | 'live' | 'dnd' | 'error' | 'away' | 'offline' | 'unread' | 'accent';

interface StatusDotProps {
  status: DotStatus;
  /** Diameter in px: 6 (inline, default), 8 (a corner of a tile), 12 (presence on an avatar). */
  size?: 6 | 8 | 10 | 12;
  /** A ring in the surface colour (set --dot-ring) when it overlaps something. */
  ring?: boolean;
  /** Pulses (a live call). Static under reduced motion. */
  pulse?: boolean;
  /** Spoken name; without one the dot is decoration. */
  label?: string;
  class?: string;
}

// The only circle in the system: a status or presence dot.
export function StatusDot({ status, size = 6, ring = false, pulse = false, label, class: extra }: StatusDotProps) {
  const cls = ['bds-dot', `bds-dot-${status}`, ring ? 'bds-dot-ring' : '', pulse ? 'bds-dot-pulse' : '', extra ?? '']
    .filter(Boolean).join(' ');
  return (
    <span
      class={cls}
      data-status={status}
      style={`--bds-dot:${size}px`}
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : 'true'}
    />
  );
}
