import type { ComponentChildren } from 'preact';
import './Badge.css';

// neutral: a quiet grey label (GUEST, "listen only", a state that's off) · accent: a state that's on / in force, an op's role.
export type BadgeTone = 'ops' | 'mod' | 'verified' | 'info' | 'danger' | 'warn' | 'success' | 'accent' | 'neutral';

interface BadgeProps {
  tone?: BadgeTone;
  children?: ComponentChildren;
  /** Tooltip: what the label means. */
  title?: string;
  /** Layout hook for the call site. */
  class?: string;
}

export function Badge({ tone = 'info', children, title, class: extra }: BadgeProps) {
  return <span class={`bds-badge bds-badge-${tone}${extra ? ` ${extra}` : ''}`} title={title}>{children}</span>;
}
