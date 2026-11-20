import { Phone, Video } from 'lucide-preact';
import { Button, ListRow } from '@boson/shared';
import { Avatar } from '../../shared/Avatar/Avatar';
import { useFriends, type CallInfo } from '../../modules/friends';
import './MissedCalls.css';

export function missedText(n: number): string {
  return `${n} missed call${n === 1 ? '' : 's'}`;
}

function when(ms: number): string {
  if (!ms) return '';
  const d = new Date(ms);
  const today = new Date();
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return d.toDateString() === today.toDateString() ? time : `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })} ${time}`;
}

// The missed calls, newest first, each with Call back. Phones: 44px rows
// and buttons.
export function MissedList({ calls, onCall, layout = 'desktop' }: { calls: readonly CallInfo[]; onCall?: () => void; layout?: 'desktop' | 'phone' }) {
  const { friends } = useFriends();
  const size = layout === 'phone' ? 'lg' : 'md';
  return (
    <ul class="missed-list">
      {calls.map((c) => (
        <ListRow
          key={c.id}
          as="li"
          size={size}
          leading={<Avatar nick={c.peer.username} accountUrl={c.peer.avatarUrl} size={28} />}
          title={c.peer.username}
          titleTone="danger"
          subtitle={`${c.video ? 'Video call' : 'Call'} · ${when(c.createdAt)}`}
          trailing={(
            <Button variant="secondary" tone="success" size={size} icon={c.video ? <Video /> : <Phone />}
              aria-label={`Call ${c.peer.username} back`}
              onClick={() => { void friends?.call(c.peer.username, c.video); onCall?.(); }} />
          )}
        />
      ))}
    </ul>
  );
}
