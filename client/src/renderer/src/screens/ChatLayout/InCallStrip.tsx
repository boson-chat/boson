import { Button, StatusDot } from '@boson/shared';
import { useVideo } from '../../modules/video';
import { useVoice } from '../../modules/voice';
import { Avatar } from '../../shared/Avatar/Avatar';
import { openCall } from './call-shared';
import { isGuestParticipant } from '../../modules/voice/guest-id';
import './CallPanel.css';

const FACES = 8;

/** Under a text channel's header while you're in a call (desktop): "In
 * General · 3 in call · kestrel is sharing their screen", who's in, and
 * "Open call". Nothing when you're not in a call. */
export function InCallStrip({ avatarFor }: { avatarFor?: (nick: string) => string | undefined }) {
  const { snap } = useVoice();
  const { snap: vsnap } = useVideo();
  const call = snap.call;
  if (!call.host || call.status !== 'connected') return null;
  const sharer = vsnap.state.tracks.find((t) => t.kind === 'screen' && !t.self)?.name
    ?? (vsnap.state.screen.on ? 'you' : null);
  const people = call.participants;
  const where = call.roomName || call.room;
  return (
    <div class="incall-strip" role="status" aria-label={`In call in ${where}`}>
      <StatusDot status="live" size={8} />
      <span class="incall-where">In {where}</span>
      <span class="incall-meta">
        {people.length} in call{sharer ? ` · ${sharer === 'you' ? "you're" : `${sharer} is`} sharing ${sharer === 'you' ? 'your' : 'their'} screen` : ''}
      </span>
      <span class="incall-faces">
        {people.slice(0, FACES).map((p) => (
          <span key={`${p.sessionId}:${p.userId}`} class="incall-face" data-speaking={p.speaking || undefined} title={isGuestParticipant(p) ? `${p.name} (guest)` : p.name}>
            <Avatar nick={p.name} url={avatarFor?.(p.name)} size={22} />
          </span>
        ))}
        {people.length > FACES && <span class="incall-more">+{people.length - FACES}</span>}
      </span>
      <span class="incall-spacer" />
      <Button variant="primary" size="sm" onClick={openCall}>Open call</Button>
    </div>
  );
}
