import { nickColor, nickInitial } from '../../modules/chat/nick-color';
import { CachedImg } from '../CachedImg';
import './Avatar.css';

interface AvatarProps {
  /** The nick this avatar represents — drives the fallback initial + color. */
  nick: string;
  /** Profile-image URL. When present, shown instead of the initial tile. */
  url?: string | null;
  /** Square edge in px. Default 24. */
  size?: number;
  /** Extra class hook for layout at the call site. */
  class?: string;
}

// One avatar to rule them all: a square tile that renders the member's
// profile image when we have one, else the nick-colored initial (the
// existing fallback — see modules/chat/nick-color.ts). Used in the member
// list and chat message rows so identity reads consistently everywhere.
export function Avatar({ nick, url, size = 24, class: className }: AvatarProps) {
  const fontPx = Math.max(9, Math.round(size * 0.42));
  const style = url
    ? `width:${size}px;height:${size}px`
    : `width:${size}px;height:${size}px;font-size:${fontPx}px;--nick-color:${nickColor(nick)}`;
  return (
    <span
      class={`bds-avatar ${url ? 'bds-avatar-has-image' : ''} ${className ?? ''}`}
      style={style}
      aria-hidden="true"
    >
      {url
        // From the image cache: a small thumbnail (2× the tile) kept on disk
        // and, decoded, in memory — every row of a nick shares one.
        ? <CachedImg class="bds-avatar-image" url={url} box={avatarBox(size)} loading="lazy" />
        : nickInitial(nick)}
    </span>
  );
}

// Thumbnail boxes in a few steps, so tiles of similar size share one.
function avatarBox(size: number): { w: number; h: number } {
  const px = size <= 32 ? 64 : size <= 64 ? 128 : 256;
  return { w: px, h: px };
}
