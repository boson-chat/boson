import type { ComponentChildren } from 'preact';
import './WarningBanner.css';

export type WarningTone = 'warn' | 'danger' | 'info';

interface WarningBannerProps {
  tone?: WarningTone;
  title: string;
  children?: ComponentChildren;
}

export function WarningBanner({ tone = 'warn', title, children }: WarningBannerProps) {
  return (
    <div class={`bds-warning bds-warning-${tone}`} role="alert">
      <div class="bds-warning-title">{title}</div>
      <div class="bds-warning-text">{children}</div>
    </div>
  );
}
