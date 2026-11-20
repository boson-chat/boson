import './GuestBadge.css';

// The small "guest" pill next to someone in voice who joined without an
// account: their name is their IRC nick, not checked by anyone.
export function GuestBadge({ title = 'Guest: not signed in. The name is their IRC nick and isn’t verified.' }: { title?: string }) {
  return <span class="guest-badge" title={title}>guest</span>;
}
