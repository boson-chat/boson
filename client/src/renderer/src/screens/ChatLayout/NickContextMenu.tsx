import { useEffect } from 'preact/hooks';
import { createPortal } from 'preact/compat';
import './NickContextMenu.css';

export interface NickContextAction {
  label: string;
  /** True ⇒ render with the danger colour (used for destructive ops). */
  danger?: boolean;
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
export function NickContextMenu({ x, y, onClose, title, actions }: NickContextMenuProps) {
  useEffect(() => {
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

  if (actions.length === 0) return null;

  // Clamp inside viewport. Rough min-width of 180px so we don't end up
  // with a sliver of menu hugging the right edge.
  const MIN_WIDTH = 180;
  const MAX_HEIGHT_PER_ITEM = 32;
  const clampedX = Math.min(x, window.innerWidth - MIN_WIDTH - 8);
  const clampedY = Math.min(y, window.innerHeight - actions.length * MAX_HEIGHT_PER_ITEM - 60);

  return createPortal(
    <div
      class="nick-context-menu"
      role="menu"
      style={`top: ${clampedY}px; left: ${clampedX}px;`}
    >
      <div class="nick-context-menu-title">{title}</div>
      {actions.map((a) => (
        <button
          key={a.label}
          type="button"
          role="menuitem"
          class={`nick-context-menu-item ${a.danger ? 'nick-context-menu-item-danger' : ''}`}
          onClick={() => { a.onClick(); onClose(); }}
        >
          {a.label}
        </button>
      ))}
    </div>,
    document.body,
  );
}
