import type { ComponentChildren, JSX } from 'preact';
import { useLayoutEffect, useRef } from 'preact/hooks';
import './Menu.css';

interface MenuProps {
  /** Accessible name. */
  label?: string;
  children: ComponentChildren;
  /** Outside press or Escape. */
  onClose?: () => void;
  /** Fixed position (a right-click menu): viewport x / y. */
  x?: number;
  y?: number;
  class?: string;
  style?: JSX.CSSProperties | string;
  /** 'dialog' for a popover that holds a control (a volume slider) rather than a list of commands. */
  role?: 'menu' | 'dialog';
}

// A popover menu (right-click, a "…" button): a raised surface with menu
// items. On phones the same items go in a Sheet instead.
export function Menu({ label, children, onClose, x, y, class: extra, style, role = 'menu' }: MenuProps) {
  const ref = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  useLayoutEffect(() => {
    if (!onClose) return;
    const onDown = (e: MouseEvent): void => {
      if (ref.current && e.target instanceof Node && ref.current.contains(e.target)) return;
      close.current?.();
    };
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') close.current?.(); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [!!onClose]);
  const pos = x != null && y != null ? `position:fixed;left:${x}px;top:${y}px;` : '';
  return (
    <div ref={ref} class={`bds-menu${extra ? ` ${extra}` : ''}`} role={role} aria-label={label}
      style={typeof style === 'string' || style == null ? `${pos}${style ?? ''}` : { ...(pos ? { position: 'fixed', left: `${x}px`, top: `${y}px` } : {}), ...style }}>
      {children}
    </div>
  );
}

interface MenuItemProps {
  children: ComponentChildren;
  onClick: () => void;
  icon?: ComponentChildren;
  /** Colours the icon (a green phone for Call). */
  iconTone?: 'success' | 'accent';
  danger?: boolean;
  /** One of a set of choices: ticked when true. */
  checked?: boolean;
  /** With `checked`: an on/off item of its own (menuitemcheckbox), not one of a set. */
  checkbox?: boolean;
  disabled?: boolean;
  /** md 32px (menus) · lg 44px (sheets). */
  size?: 'md' | 'lg';
  ariaLabel?: string;
  class?: string;
}

export function MenuItem({ children, onClick, icon, iconTone, danger = false, checked, checkbox = false, disabled, size = 'md', ariaLabel, class: extra }: MenuItemProps) {
  const cls = ['bds-menu-item', `bds-menu-item-${size}`, danger ? 'bds-menu-item-danger' : '', extra ?? ''].filter(Boolean).join(' ');
  return (
    <button type="button" class={cls} role={checked === undefined ? 'menuitem' : checkbox ? 'menuitemcheckbox' : 'menuitemradio'} aria-checked={checked}
      aria-label={ariaLabel} disabled={disabled} onClick={onClick}>
      {checked !== undefined && <span class="bds-menu-check" aria-hidden="true">{checked ? '✓' : ''}</span>}
      {icon != null && <span class={`bds-menu-icon${iconTone ? ` bds-menu-icon-${iconTone}` : ''}`} aria-hidden="true">{icon}</span>}
      <span class="bds-menu-text">{children}</span>
    </button>
  );
}

// A heading inside a menu (the nick it's for).
export function MenuLabel({ children, class: extra }: { children: ComponentChildren; class?: string }) {
  return <div class={`bds-menu-label${extra ? ` ${extra}` : ''}`}>{children}</div>;
}

export function MenuSeparator() {
  return <div class="bds-menu-sep" role="separator" />;
}
