import type { ComponentChildren, JSX } from 'preact';
import './ListRow.css';

interface ListRowProps {
  /** Avatar, icon or status dot on the left. */
  leading?: ComponentChildren;
  title: ComponentChildren;
  /** Colours the title: a missed call (danger), a live call (success). */
  titleTone?: 'danger' | 'success';
  /** Small mono text after the title (where, when). */
  meta?: ComponentChildren;
  /** Pushed to the far right of the title line (a time). */
  aside?: ComponentChildren;
  subtitle?: ComponentChildren;
  /** How many lines the subtitle may take (default 1). */
  subtitleLines?: 1 | 2;
  /** Buttons, a switch or a count on the right. */
  trailing?: ComponentChildren;
  /** Makes the row's body (leading + text) one button. */
  onClick?: (e: MouseEvent) => void;
  /** The body button's accessible name. */
  ariaLabel?: string;
  /** item: a row in a list (divider under it) · nav: a sidebar entry. */
  variant?: 'item' | 'nav';
  /** md (desktop) · lg (phones: bigger text, 16px inset, 44px+ targets). */
  size?: 'md' | 'lg';
  selected?: boolean;
  unread?: boolean;
  /** Extra content under the row's main line (a phone row's switch). */
  children?: ComponentChildren;
  /** li in a ul/ol, div otherwise. */
  as?: 'div' | 'li';
  class?: string;
  rowProps?: JSX.HTMLAttributes<HTMLElement>;
}

// A row in a list: friends, calls, missed calls, the bell's entries, MY's
// direct messages (and, as variant "nav", a sidebar's entries).
export function ListRow({
  leading, title, titleTone, meta, aside, subtitle, subtitleLines = 1, trailing, onClick, ariaLabel,
  variant = 'item', size = 'md', selected = false, unread = false, children, as = 'div', class: extra, rowProps,
}: ListRowProps) {
  const cls = [
    'bds-row', `bds-row-${variant}`, `bds-row-${size}`,
    selected ? 'bds-row-selected' : '', unread ? 'bds-row-unread' : '',
    onClick ? 'bds-row-clickable' : '', extra ?? '',
  ].filter(Boolean).join(' ');
  const body = (
    <>
      {leading != null && <span class="bds-row-lead">{leading}</span>}
      <span class="bds-row-text">
        <span class="bds-row-head">
          <span class={`bds-row-title${titleTone ? ` bds-row-title-${titleTone}` : ''}`}>{title}</span>
          {meta != null && <span class="bds-row-meta">{meta}</span>}
          {aside != null && <span class="bds-row-aside">{aside}</span>}
        </span>
        {subtitle != null && <span class={`bds-row-sub bds-row-sub-${subtitleLines}`}>{subtitle}</span>}
      </span>
    </>
  );
  const Tag = as;
  return (
    <Tag {...(rowProps as unknown as JSX.HTMLAttributes<HTMLDivElement> & JSX.HTMLAttributes<HTMLLIElement>)} class={cls} aria-current={variant === 'nav' && selected ? 'page' : undefined}>
      <span class="bds-row-line">
        {onClick
          ? <button type="button" class="bds-row-main" aria-label={ariaLabel} onClick={onClick}>{body}</button>
          : <span class="bds-row-main">{body}</span>}
        {trailing != null && <span class="bds-row-trail">{trailing}</span>}
      </span>
      {children}
    </Tag>
  );
}
