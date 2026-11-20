import { useEffect, useState } from 'preact/hooks';

// Where the friends UI is: the desktop's Friends page (the rail's MY tile)
// in place of the server's columns, the phone's bottom tab, and the IRC
// server whose member names the person menus are for.
export interface FriendsUi {
  // Desktop: the Friends page is open.
  page: boolean;
  // Phones: the bottom bar's tab.
  tab: 'chats' | 'friends' | 'calls';
  // The active IRC server's host (ChatLayout sets it).
  host: string | null;
}

let ui: FriendsUi = { page: false, tab: 'chats', host: null };
const listeners = new Set<(u: FriendsUi) => void>();

export function getFriendsUi(): FriendsUi {
  return ui;
}

export function setFriendsUi(patch: Partial<FriendsUi>): void {
  const next = { ...ui, ...patch };
  if (next.page === ui.page && next.tab === ui.tab && next.host === ui.host) return;
  ui = next;
  listeners.forEach((fn) => fn(ui));
}

export function useFriendsUi(): FriendsUi {
  const [u, setU] = useState(ui);
  useEffect(() => {
    setU(ui);
    listeners.add(setU);
    return () => { listeners.delete(setU); };
  }, []);
  return u;
}
