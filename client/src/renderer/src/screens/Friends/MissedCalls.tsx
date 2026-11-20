import { useEffect, useRef, useState } from 'preact/hooks';
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

// Desktop title bar: "● 2 missed calls"; opens the list (and marks them seen).
export function MissedCallsPill() {
  const { friends, snap } = useFriends();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent): void => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); };
  }, [open]);
  if (!friends || (!snap.missed && !open)) return null;
  return (
    <div class="missed-pill-wrap" ref={ref}>
      {snap.missed > 0 && (
        <button type="button" class="missed-pill" aria-haspopup="dialog" aria-expanded={open}
          onClick={() => { setOpen(true); void friends.seeMissed(); }}>
          <span aria-hidden="true">●</span> {missedText(snap.missed)}
        </button>
      )}
      {open && (
        <div class="missed-pop" role="dialog" aria-label="Missed calls">
          <div class="missed-pop-title">MISSED CALLS</div>
          {snap.missedCalls.length > 0 ? <MissedList calls={snap.missedCalls} onCall={() => setOpen(false)} /> : <p class="missed-none">None.</p>}
        </div>
      )}
    </div>
  );
}
