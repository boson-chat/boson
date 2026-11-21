// Deep links on the web: a boson://join link can't open a page, so links
// to the web app carry it in the URL instead, read once on load:
//   https://chat.boson.chat/?join=<a boson://join?… URL>
//   https://chat.boson.chat/join?host=…&port=…&tls=1[&name=…]
// The URL is then cleaned (history.replaceState) so a reload doesn't
// join again.

export function joinUrlFromLocation(loc: Pick<Location, 'pathname' | 'search'>): string | null {
  const q = new URLSearchParams(loc.search);
  const join = q.get('join');
  if (join && join.startsWith('boson://')) return join;
  if (/\/join\/?$/.test(loc.pathname) && q.get('host')) {
    const out = new URLSearchParams();
    for (const k of ['host', 'port', 'tls', 'name']) {
      const v = q.get(k);
      if (v !== null) out.set(k, v);
    }
    return `boson://join?${out.toString()}`;
  }
  return null;
}

export function webDeepLinkBridge(win: Window = window): {
  consume: () => Promise<string | null>;
  onJoin: (fn: (url: string) => void) => () => void;
  deliver: (url: string) => void;
} {
  let pending = joinUrlFromLocation(win.location);
  if (pending) {
    const base = win.location.pathname.replace(/\/join\/?$/, '/');
    win.history.replaceState(null, '', base + win.location.hash);
  }
  const listeners = new Set<(url: string) => void>();
  return {
    consume: async () => {
      const url = pending;
      pending = null;
      return url;
    },
    onJoin: (fn) => {
      listeners.add(fn);
      return () => { listeners.delete(fn); };
    },
    deliver: (url) => {
      if (listeners.size === 0) pending = url;
      for (const fn of listeners) fn(url);
    },
  };
}
