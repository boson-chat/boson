import { useEffect, useState } from 'preact/hooks';
import { getNotificationFeed, type FeedSnapshot } from './feed';

// The in-app notifications (toasts and the bell's friend/call entries).
export function useFeed(): FeedSnapshot {
  const feed = getNotificationFeed();
  const [s, set] = useState(() => feed.getSnapshot());
  useEffect(() => {
    set(feed.getSnapshot());
    return feed.subscribe(set);
  }, [feed]);
  return s;
}
