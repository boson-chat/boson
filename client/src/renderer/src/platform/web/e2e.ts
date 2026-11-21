// window.bosonE2E for the web build under the real-app e2e suite: the
// stand-ins for what the OS does that the web can do too. Installed only
// when the e2e config says so (tests/e2e-app/web-app.ts serves it).
// Hooks the web has no equivalent for are absent; specs that need them
// skip on the web (tests/e2e-app/README.md).

export function installWebE2E(w: Record<string, unknown>, deps: { deliverDeepLink: (url: string) => void }): void {
  const opened: string[] = [];
  const realOpen = window.open.bind(window);
  // Links the app opens in a new tab are recorded instead (a test never
  // opens real sites), except the app's own SSO popup.
  window.open = ((url?: string | URL, target?: string, features?: string) => {
    if (url !== undefined && target !== 'boson-sso') {
      opened.push(new URL(String(url), location.href).href);
      return null;
    }
    return realOpen(url, target, features);
  }) as typeof window.open;
  document.addEventListener('click', (ev) => {
    const a = (ev.target as Element | null)?.closest?.('a[href]') as HTMLAnchorElement | null;
    if (!a || ev.defaultPrevented) return;
    const dest = new URL(a.href, location.href);
    if (dest.origin === location.origin) return;
    ev.preventDefault();
    opened.push(dest.href);
  }, true);
  w.bosonE2E = {
    web: true,
    openedLinks: async () => [...opened],
    // A second launch with a boson:// URL: on the web, a link to the app
    // carrying it, while the app is open.
    secondInstance: async (args: string[]) => {
      for (const a of args) if (a.startsWith('boson://')) deps.deliverDeepLink(a);
    },
  };
}
