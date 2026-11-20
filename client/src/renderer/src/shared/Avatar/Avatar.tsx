import { useEffect, useState } from 'preact/hooks';
import { Avatar as AvatarTile, type DotStatus } from '@boson/shared';
import { getAvatar, getAvatarAnyServer, subscribeAvatars } from '../../modules/chat/avatar-cache';
import { nickColor, nickInitial } from '../../modules/chat/nick-color';
import { CachedImg } from '../CachedImg';

interface AvatarProps {
  /** The nick this avatar represents — drives the fallback initial + color. */
  nick: string;
  /**
   * Profile-image URL, when the caller has already resolved it (chat rows,
   * members). Passing the prop at all — even undefined — means "this is the
   * answer". Leave it out and the avatar finds the picture itself: the
   * account's (accountUrl), else the avatar cache for serverId, else the
   * nick on any connected server; it updates when the cache fills.
   */
  url?: string | null;
  /** The account's own picture (friends / calls API), tried first when url is left out. */
  accountUrl?: string | null;
  /** The IRC server the nick is on, when known. */
  serverId?: string;
  /** Square edge in px. Default 24. */
  size?: number;
  /** A presence dot on the corner. */
  status?: DotStatus;
  /** Ringing (an incoming / outgoing call): a pulsing green ring. */
  ringing?: boolean;
  /** Faded (blocked). */
  dim?: boolean;
  /** Extra class hook for layout at the call site. */
  class?: string;
}

// A nick's avatar: the design system's rounded-square tile with the
// member's profile image when we have one, else the nick-coloured initial
// (modules/chat/nick-color.ts). Used everywhere a person is shown.
export function Avatar(props: AvatarProps) {
  const { nick, size = 24, status, ringing, dim, class: className } = props;
  const resolved = useResolvedAvatar(nick, !('url' in props) && !props.accountUrl, props.serverId);
  const url = 'url' in props ? props.url : (props.accountUrl || resolved);
  return (
    <AvatarTile
      size={size}
      initial={nickInitial(nick)}
      color={url ? undefined : nickColor(nick)}
      // From the image cache: a small thumbnail (2× the tile) kept on disk
      // and, decoded, in memory — every row of a nick shares one.
      image={url ? <CachedImg class="bds-avatar-image" url={url} box={avatarBox(size)} loading="lazy" /> : undefined}
      status={status}
      ringing={ringing}
      dim={dim}
      class={className}
    />
  );
}

// Thumbnail boxes in a few steps, so tiles of similar size share one.
function avatarBox(size: number): { w: number; h: number } {
  const px = size <= 32 ? 64 : size <= 64 ? 128 : 256;
  return { w: px, h: px };
}

function lookup(nick: string, serverId?: string): string | undefined {
  return (serverId ? getAvatar(serverId, nick) : undefined) ?? getAvatarAnyServer(nick);
}

// The cached picture for a nick, kept current. Only subscribes when the
// caller didn't resolve it (chat rows do, and render many).
function useResolvedAvatar(nick: string, enabled: boolean, serverId?: string): string | undefined {
  const [url, setUrl] = useState(() => (enabled ? lookup(nick, serverId) : undefined));
  useEffect(() => {
    if (!enabled) return;
    const update = (): void => setUrl(lookup(nick, serverId));
    update();
    return subscribeAvatars(update);
  }, [enabled, nick, serverId]);
  return enabled ? url : undefined;
}
