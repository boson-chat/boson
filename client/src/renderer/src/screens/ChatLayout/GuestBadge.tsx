import { Badge } from '@boson/shared';
import './GuestBadge.css';

// The small "guest" label next to someone in voice who joined without an
// account: their name is their IRC nick, not checked by anyone.
export function GuestBadge({ title = 'Guest: not signed in. The name is their IRC nick and isn’t verified.' }: { title?: string }) {
  return <Badge tone="neutral" class="guest-badge" title={title}>guest</Badge>;
}
