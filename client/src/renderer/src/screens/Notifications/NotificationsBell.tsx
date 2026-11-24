import { Bell } from 'lucide-preact';
import { Button, Count } from '@boson/shared';
import { openNotifications } from '../../modules/ui/open-notifications';
import { useUnreadNotes } from './NotificationsPanel';
import './NotificationsBell.css';

interface Props {
  count: number;
  onClick: () => void;
  // While its list shows: the accent, as on any open toggle.
  open?: boolean;
  // sm on a desktop's title bar; lg (44px) on phones.
  size?: 'sm' | 'lg';
  // How its unread count reads ("Notifications, 3 unread").
  countWord?: string;
  class?: string;
}

// The bell (mentions, DMs, memos, friends, calls) with its unread count. It
// opens the notifications list: from the title bar on a desktop, from the
// server rail on a phone.
export function NotificationsBell({ count, onClick, open = false, size = 'sm', countWord = 'unread', class: extra }: Props) {
  return (
    <Button
      variant="ghost"
      size={size}
      class={`title-bar-bell notes-bell${open ? ' title-bar-bell-on' : ''}${extra ? ` ${extra}` : ''}`}
      aria-label={count > 0 ? `Notifications, ${count} ${countWord}` : 'Notifications'}
      aria-haspopup="dialog"
      aria-expanded={open}
      title="Notifications"
      onClick={onClick}
      icon={(
        <>
          <Bell aria-hidden="true" />
          <Count value={count} size={size === 'lg' ? 'md' : 'sm'} overlay class="notes-bell-badge" />
        </>
      )}
    />
  );
}

// A phone's bell, in the server rail under your avatar (the top bar is gone
// on phones): the same count as the conversation header's ⋮ dot.
export function RailBell() {
  const count = useUnreadNotes();
  return <NotificationsBell size="lg" class="rail-bell" count={count} countWord="new" onClick={openNotifications} />;
}
