import type { ComponentChildren } from 'preact';
import { Button } from '../Button/Button';
import './PageHeader.css';

interface PageHeaderProps {
  title: ComponentChildren;
  sub?: ComponentChildren;
  /** Phones: a back arrow before the title. */
  onBack?: () => void;
  backLabel?: string;
  /** The back arrow's icon (the app passes its icon set's arrow). */
  backIcon?: ComponentChildren;
  /** desktop: 64px, 20px title · phone: 54px, 16px title. */
  layout?: 'desktop' | 'phone';
  /** Right-hand buttons. */
  actions?: ComponentChildren;
  /** Between the title and the actions (tabs on desktop). */
  children?: ComponentChildren;
  class?: string;
}

// The top of a page (Friends, Calls, Notifications, members): title and
// subtitle, a back arrow on phones, tabs and actions.
export function PageHeader({ title, sub, onBack, backLabel = 'Back', backIcon, layout = 'desktop', actions, children, class: extra }: PageHeaderProps) {
  return (
    <header class={`bds-page-head bds-page-head-${layout}${extra ? ` ${extra}` : ''}`}>
      {onBack && (
        <Button variant="ghost" size="lg" icon={backIcon ?? <span aria-hidden="true">←</span>} aria-label={backLabel} onClick={onBack} class="bds-page-back" />
      )}
      <span class="bds-page-titles">
        <h1 class="bds-page-title">{title}</h1>
        {sub != null && <span class="bds-page-sub">{sub}</span>}
      </span>
      {children}
      {actions != null && <span class="bds-page-actions">{actions}</span>}
    </header>
  );
}
