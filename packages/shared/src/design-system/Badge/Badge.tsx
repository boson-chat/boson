import type { ComponentChildren } from 'preact';
import './Badge.css';

export type BadgeTone = 'ops' | 'mod' | 'verified' | 'info' | 'danger' | 'warn' | 'success';

interface BadgeProps {
  tone?: BadgeTone;
  children?: ComponentChildren;
}

export function Badge({ tone = 'info', children }: BadgeProps) {
  return <span class={`bds-badge bds-badge-${tone}`}>{children}</span>;
}
