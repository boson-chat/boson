import { Bell } from 'lucide-preact';
import { Button, Count } from '@boson/shared';
import { hasNotificationsOpener, openNotifications } from '../../modules/ui/open-notifications';
import { titleBarYields } from '../TitleBar/TitleBar';
import { useUnreadNotes } from './NotificationsPanel';

// The bell in a phone's conversation header: there the title bar steps
// aside (one header, not two), so its bell moves here. Nothing elsewhere,
// or where the title bar stays (a narrow desktop window).
export function HeaderBell() {
  const unread = useUnreadNotes();
  if (!titleBarYields() || !hasNotificationsOpener()) return null;
  return (
    <Button
      variant="ghost"
      size="lg"
      class="chat-header-bell"
      aria-label={unread > 0 ? `Notifications, ${unread} unread` : 'Notifications'}
      aria-haspopup="dialog"
      title="Notifications"
      onClick={openNotifications}
      icon={(
        <>
          <Bell aria-hidden="true" />
          <Count value={unread} size="md" overlay class="chat-header-bell-badge" />
        </>
      )}
    />
  );
}
