import type { ComponentChildren } from 'preact';
import './Badge.css';

// accent: a state that's on / in force (data saver on, a channel's cap) · neutral: the same state when off.
export type BadgeTone = 'ops' | 'mod' | 'verified' | 'info' | 'danger' | 'warn' | 'success' | 'accent' | 'neutral';

interface BadgeProps {
  tone?: BadgeTone;
  children?: ComponentChildren;
}

export function Badge({ tone = 'info', children }: BadgeProps) {
  return <span class={`bds-badge bds-badge-${tone}`}>{children}</span>;
}
