import { useCallback, useEffect, useState } from 'preact/hooks';
import { getAvatar, subscribeAvatars } from '../../modules/chat/avatar-cache';

// Returns a `(nick) => url | undefined` resolver for the given server,
// re-rendering the caller when the avatar cache changes. One subscription
// per list (member list / message list) rather than one per row.
export function useAvatarFor(serverId: string | null): (nick: string) => string | undefined {
  const [, bump] = useState(0);
  useEffect(() => subscribeAvatars(() => bump((n) => n + 1)), []);
  return useCallback(
    (nick: string) => (serverId ? getAvatar(serverId, nick) : undefined),
    [serverId],
  );
}
