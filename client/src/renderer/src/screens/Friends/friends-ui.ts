import { useEffect, useState } from 'preact/hooks';

// MY: your own space at the top of the rail (your avatar). Its sidebar has
// Friends and Calls above your direct messages; `myView` is what the main
// column shows (the Friends page, the Calls page, or the conversation).
export type MyView = 'friends' | 'calls' | 'chat';

// Where the friends UI is: MY and its page, the phone's bottom tab, and the
// IRC server whose member names the person menus are for.
export interface FriendsUi {
  // MY is selected in the rail (in place of a server).
  my: boolean;
  myView: MyView;
  // Phones: the bottom bar's tab.
  tab: 'chats' | 'friends' | 'calls';
  // The active IRC server's host (ChatLayout sets it).
  host: string | null;
}

let ui: FriendsUi = { my: false, myView: 'friends', tab: 'chats', host: null };
const listeners = new Set<(u: FriendsUi) => void>();

export function getFriendsUi(): FriendsUi {
  return ui;
}

export function setFriendsUi(patch: Partial<FriendsUi>): void {
  const next = { ...ui, ...patch };
  if (next.my === ui.my && next.myView === ui.myView && next.tab === ui.tab && next.host === ui.host) return;
  ui = next;
  listeners.forEach((fn) => fn(ui));
}

// MY, showing `view`.
export function openMy(view: MyView = getFriendsUi().myView): void {
  setFriendsUi({ my: true, myView: view });
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
