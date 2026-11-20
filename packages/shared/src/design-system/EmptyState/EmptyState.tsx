import type { ComponentChildren } from 'preact';
import './EmptyState.css';

interface EmptyStateProps {
  /** A line icon above (optional). */
  icon?: ComponentChildren;
  title?: ComponentChildren;
  /** What's missing and what to do about it. */
  children?: ComponentChildren;
  /** A button. */
  action?: ComponentChildren;
  class?: string;
}

// Nothing here yet: one centred block of quiet text, optionally with an
// icon, a title and a button.
export function EmptyState({ icon, title, children, action, class: extra }: EmptyStateProps) {
  return (
    <div class={`bds-empty${extra ? ` ${extra}` : ''}`}>
      {icon != null && <span class="bds-empty-icon" aria-hidden="true">{icon}</span>}
      {title != null && <p class="bds-empty-title">{title}</p>}
      {children != null && <p class="bds-empty-text">{children}</p>}
      {action != null && <div class="bds-empty-action">{action}</div>}
    </div>
  );
}
