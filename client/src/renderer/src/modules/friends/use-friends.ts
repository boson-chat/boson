import { useEffect, useState } from 'preact/hooks';
import { EMPTY_FRIENDS, getFriendsController, onFriendsControllerChange, type FriendsController, type FriendsSnapshot } from './friends.controller';

// The friends controller and its snapshot (re-renders on change).
export function useFriends(): { friends: FriendsController | null; snap: FriendsSnapshot } {
  const [ctl, setCtl] = useState(() => getFriendsController());
  const [snap, setSnap] = useState<FriendsSnapshot>(() => ctl?.getSnapshot() ?? EMPTY_FRIENDS);
  useEffect(() => onFriendsControllerChange(() => setCtl(getFriendsController())), []);
  useEffect(() => {
    if (!ctl) { setSnap(EMPTY_FRIENDS); return; }
    setSnap(ctl.getSnapshot());
    return ctl.subscribe(setSnap);
  }, [ctl]);
  return { friends: ctl, snap };
}
