import { useRef, useState } from 'preact/hooks';
import { EllipsisVertical } from 'lucide-preact';
import { Button, Count, Menu, MenuItem } from '@boson/shared';
import { hasNotificationsOpener, openNotifications } from '../../modules/ui/open-notifications';
import { titleBarYields } from '../../shared/window-controls';
import { useUnreadNotes } from '../Notifications/NotificationsPanel';

interface HeaderMoreProps {
  /** The conversation's members: a channel's (a DM has none). */
  memberCount?: number;
  onMembers?: () => void;
  onSettings?: () => void;
}

// A phone's conversation header keeps the name and Search; the rest goes
// behind ⋮: Members, the bell's list (the title bar steps aside there, so
// its bell has no other home), Channel settings. The ⋮ carries the bell's
// unread dot. Anchored under the button, like a channel row's "…" menu.
// Nothing that applies (a DM where the title bar keeps its bell): no ⋮.
export function HeaderMore({ memberCount, onMembers, onSettings }: HeaderMoreProps) {
  const unread = useUnreadNotes();
  const [at, setAt] = useState<{ top: number; right: number } | null>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const bell = titleBarYields() && hasNotificationsOpener();
  if (!onMembers && !onSettings && !bell) return null;

  const toggle = (): void => {
    if (at) { setAt(null); return; }
    const r = btn.current?.getBoundingClientRect();
    if (!r) return;
    setAt({ top: r.bottom + 2, right: Math.max(4, document.documentElement.clientWidth - r.right) });
  };
  const pick = (fn: () => void) => (): void => { setAt(null); fn(); };
  const dot = bell && unread > 0;

  return (
    <>
      <Button
        buttonRef={btn}
        variant="ghost"
        size="lg"
        class="chat-header-more"
        aria-haspopup="menu"
        aria-expanded={!!at}
        aria-label="More options"
        title={dot ? `More options (${unread} unread notifications)` : 'More options'}
        // Not an outside press for the open menu: the click toggles it.
        onMouseDown={(e: MouseEvent) => e.stopPropagation()}
        onClick={toggle}
        icon={(
          <>
            <EllipsisVertical aria-hidden="true" />
            {dot && <span class="chat-header-more-dot" aria-hidden="true" />}
          </>
        )}
      />
      {at && (
        <Menu label="More options" class="chat-header-menu" onClose={() => setAt(null)}
          style={{ position: 'fixed', top: `${at.top}px`, right: `${at.right}px` }}>
          {onMembers && (
            <MenuItem size="lg" class="chat-header-menu-item" onClick={pick(onMembers)}
              ariaLabel={memberCount !== undefined ? `Members (${memberCount})` : 'Members'}>
              <span>Members</span>
              {memberCount !== undefined && <span class="chat-header-menu-n">{memberCount}</span>}
            </MenuItem>
          )}
          {bell && (
            <MenuItem size="lg" class="chat-header-menu-item" onClick={pick(openNotifications)}
              ariaLabel={unread > 0 ? `Notifications, ${unread} unread` : 'Notifications'}>
              <span>Notifications</span>
              <Count value={unread} size="md" />
            </MenuItem>
          )}
          {onSettings && (
            <MenuItem size="lg" class="chat-header-menu-item" onClick={pick(onSettings)}>
              Channel settings
            </MenuItem>
          )}
        </Menu>
      )}
    </>
  );
}
