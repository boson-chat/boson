import { Phone, Video } from 'lucide-preact';
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

// The missed calls, newest first, each with Call back.
export function MissedList({ calls, onCall }: { calls: readonly CallInfo[]; onCall?: () => void }) {
  const { friends } = useFriends();
  return (
    <ul class="missed-list">
      {calls.map((c) => (
        <li key={c.id} class="missed-row">
          <Avatar nick={c.peer.username} size={28} />
          <span class="missed-who">
            <span class="missed-name">{c.peer.username}</span>
            <span class="missed-when">{c.video ? 'Video call' : 'Call'} · {when(c.createdAt)}</span>
          </span>
          <button type="button" class="missed-call" aria-label={`Call ${c.peer.username} back`}
            onClick={() => { void friends?.call(c.peer.username, c.video); onCall?.(); }}>
            {c.video ? <Video size={15} aria-hidden="true" /> : <Phone size={15} aria-hidden="true" />}
          </button>
        </li>
      ))}
    </ul>
  );
}
