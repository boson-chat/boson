import type { ComponentChildren } from 'preact';
import './Badge.css';

export type BadgeTone = 'ops' | 'mod' | 'verified' | 'info' | 'danger' | 'warn' | 'success';

interface BadgeProps {
  tone?: BadgeTone;
  children?: ComponentChildren;
  /** Layout hook (margins, a test hook) for the call site. Not for restyling. */
  class?: string;
  title?: string;
}

export function Badge({ tone = 'info', children, class: extra, title }: BadgeProps) {
  return <span class={`bds-badge bds-badge-${tone}${extra ? ` ${extra}` : ''}`} title={title}>{children}</span>;
}
