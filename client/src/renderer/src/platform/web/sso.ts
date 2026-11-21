// "Sign in with …" on the web: the identity provider's page opens in a
// popup and comes back to /sso/callback on this origin (sso-callback.html),
// which hands the one-time code back over a BroadcastChannel and closes.
// The renderer's flow (modules/auth/sso.ts) is unchanged: PKCE, then
// POST /v1/sso/exchange. The `s` parameter is random per flow; only a
// callback carrying it is accepted.

export const SSO_CHANNEL = 'boson-sso';

export interface SSOCallbackMessage {
  s: string;
  code?: string;
  error?: string;
  errorDescription?: string;
}

interface Flow {
  done: Promise<{ code?: string; error?: string; errorDescription?: string }>;
  resolve: (r: { code?: string; error?: string; errorDescription?: string }) => void;
  popup: Window | null;
  timer: ReturnType<typeof setInterval> | null;
}

function randomId(): string {
  const b = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}

export function webSSOBridge(win: Window = window): {
  begin: () => Promise<{ id: string; redirectUri: string }>;
  wait: (id: string) => Promise<{ code?: string; error?: string; errorDescription?: string }>;
  cancel: (id: string) => Promise<void>;
  open: (url: string) => Promise<void>;
} {
  const flows = new Map<string, Flow>();
  let last: string | null = null;
  const channel = typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel(SSO_CHANNEL);
  const onMessage = (data: unknown): void => {
    const m = data as SSOCallbackMessage;
    if (!m || typeof m.s !== 'string') return;
    const f = flows.get(m.s);
    if (!f) return;
    f.resolve(m.code ? { code: m.code } : { error: m.error || 'sso_failed', errorDescription: m.errorDescription });
  };
  if (channel) channel.onmessage = (ev) => onMessage(ev.data);
  // The callback page also posts to its opener (where BroadcastChannel
  // is partitioned differently).
  win.addEventListener('message', (ev) => { if (ev.origin === win.location.origin) onMessage(ev.data); });

  return {
    async begin() {
      const id = randomId();
      let resolve!: Flow['resolve'];
      const done = new Promise<{ code?: string; error?: string; errorDescription?: string }>((r) => { resolve = r; });
      const flow: Flow = { done, resolve, popup: null, timer: null };
      flow.done.finally(() => {
        if (flow.timer) clearInterval(flow.timer);
        try { flow.popup?.close(); } catch { /* cross-origin */ }
        flows.delete(id);
      });
      flows.set(id, flow);
      last = id;
      const redirectUri = new URL(`sso/callback?s=${id}`, new URL('./', win.location.href)).toString();
      return { id, redirectUri };
    },
    wait(id) {
      return flows.get(id)?.done ?? Promise.resolve({ error: 'cancelled' });
    },
    async cancel(id) {
      flows.get(id)?.resolve({ error: 'cancelled' });
    },
    async open(url) {
      const f = last ? flows.get(last) : undefined;
      const popup = win.open(url, 'boson-sso', 'popup,width=520,height=720');
      if (!popup) {
        f?.resolve({ error: 'popup_blocked', errorDescription: 'Your browser blocked the sign-in window. Allow pop-ups for this site and try again.' });
        return;
      }
      if (f) {
        f.popup = popup;
        // Closing the popup by hand cancels (after a moment: the callback
        // page closes itself right after posting the code).
        f.timer = setInterval(() => {
          if (!popup.closed) return;
          if (f.timer) clearInterval(f.timer);
          f.timer = null;
          setTimeout(() => f.resolve({ error: 'cancelled' }), 1500);
        }, 500);
      }
    },
  };
}
