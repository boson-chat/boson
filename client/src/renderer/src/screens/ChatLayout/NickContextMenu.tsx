import { useLayoutEffect } from 'preact/hooks';
import { createPortal } from 'preact/compat';
import { PersonMenu, usePersonRelation } from '../Friends/PersonMenu';
import './NickContextMenu.css';

export interface NickContextAction {
  label: string;
  /** True ⇒ render with the danger colour (used for destructive ops). */
  danger?: boolean;
  /** One of a set of choices (Notifications: All / Mentions / Nothing): shown ticked when true. */
  checked?: boolean;
  onClick: () => void;
}

interface NickContextMenuProps {
  /** Cursor x/y from the contextmenu event (clientX / clientY). */
  x: number;
  y: number;
  /** Closes the menu — wired to outside-click + Escape + every action. */
  onClose: () => void;
  /** Visible label for the menu's header — typically the nick itself. */
  title: string;
  /** Ordered list of action buttons. Empty list ⇒ no menu rendered. */
  actions: readonly NickContextAction[];
  /** The nick's account, when known (friend and call actions). */
  account?: string;
}

// Right-click context menu rendered via portal at document.body so it
// escapes any overflow-clipped ancestor (server rail, member list scroll
// container, etc). Position is fixed (viewport-relative) and clamped so
// the menu never spills off the right or bottom edge of the window.
//
// Closes on:
//   - outside click (anywhere outside the menu's own DOM)
//   - Escape keypress
//   - any action's onClick (the caller's onClick is invoked first, then
//     onClose so the action sees the menu's state before it goes away).
export function NickContextMenu({ x, y, onClose, title, actions, account }: NickContextMenuProps) {
  // Layout effect: the listeners are in place before the menu is painted,
  // so an Escape or outside click right after it appears isn't missed.
  useLayoutEffect(() => {
    const onDown = (e: MouseEvent): void => {
      const t = e.target as HTMLElement | null;
      if (t && t.closest('.nick-context-menu')) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  // Room for the friend and call actions too (up to six more rows).
  const person = usePersonRelation(title, account);
  if (actions.length === 0) return null;

  // Clamp inside viewport. Rough min-width of 180px so we don't end up
  // with a sliver of menu hugging the right edge.
  const MIN_WIDTH = 180;
  const MAX_HEIGHT_PER_ITEM = 32;
  const clampedX = Math.min(x, window.innerWidth - MIN_WIDTH - 8);
  const rows = actions.length + (person ? 6 : 0);
  const clampedY = Math.max(8, Math.min(y, window.innerHeight - rows * MAX_HEIGHT_PER_ITEM - 60));

  return createPortal(
    <div
      class="nick-context-menu"
      role="menu"
      style={`top: ${clampedY}px; left: ${clampedX}px;`}
    >
      <div class="nick-context-menu-title">{title}</div>
      <PersonMenu nick={title} account={account} variant="menu" onDone={onClose} />
      {actions.map((a) => (
        <button
          key={a.label}
          type="button"
          role={a.checked === undefined ? 'menuitem' : 'menuitemradio'}
          aria-checked={a.checked}
          class={`nick-context-menu-item ${a.danger ? 'nick-context-menu-item-danger' : ''}`}
          onClick={() => { a.onClick(); onClose(); }}
        >
          {a.checked !== undefined && <span class="menu-check" aria-hidden="true">{a.checked ? '✓' : ''}</span>}
          {a.label}
        </button>
      ))}
    </div>,
    document.body,
  );
}
