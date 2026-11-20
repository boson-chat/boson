import { Menu, MenuItem, MenuLabel } from '@boson/shared';
import { createPortal } from 'preact/compat';
import { PersonMenu, usePersonRelation } from '../Friends/PersonMenu';

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
    <Menu x={clampedX} y={clampedY} onClose={onClose} class="nick-context-menu">
      <MenuLabel class="nick-context-menu-title">{title}</MenuLabel>
      <PersonMenu nick={title} account={account} variant="menu" onDone={onClose} />
      {actions.map((a) => (
        <MenuItem
          key={a.label}
          danger={a.danger}
          checked={a.checked}
          class="nick-context-menu-item"
          onClick={() => { a.onClick(); onClose(); }}
        >
          {a.label}
        </MenuItem>
      ))}
    </Menu>,
    document.body,
  );
}
