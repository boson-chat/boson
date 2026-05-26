// Guest mode: lets users use Boson without a Supabase account. Stores just
// the chosen IRC nick in localStorage. No backend /me call, no identity
// unlock, no encrypted keys — guests can browse the server directory + IRC
// freely, but features that need an account (server registration, etc.)
// stay unavailable.
//
// Toggled by the LoginScreen's "Continue as guest" path. App router checks
// `loadGuestSession()` and bypasses the Supabase + identity gates when set.

const STORAGE_KEY = 'boson:guest:v1';

export interface GuestSession {
  // Local-only IRC nick. Sanitised before going on the wire.
  nick: string;
}

interface Storage {
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
  removeItem(k: string): void;
}

function getStorage(): Storage | null {
  if (typeof globalThis === 'undefined') return null;
  const ls = (globalThis as { localStorage?: Storage }).localStorage;
  return ls ?? null;
}

export function loadGuestSession(): GuestSession | null {
  const s = getStorage();
  if (!s) return null;
  try {
    const raw = s.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object') return null;
    const obj = parsed as { nick?: unknown };
    if (typeof obj.nick !== 'string' || obj.nick.length === 0) return null;
    return { nick: obj.nick };
  } catch {
    return null;
  }
}

export function saveGuestSession(g: GuestSession): void {
  const s = getStorage();
  if (!s) return;
  try { s.setItem(STORAGE_KEY, JSON.stringify(g)); } catch { /* best-effort */ }
}

export function clearGuestSession(): void {
  const s = getStorage();
  if (!s) return;
  try { s.removeItem(STORAGE_KEY); } catch { /* best-effort */ }
}

// Convenience event so multiple components can react to guest changes
// without prop-drilling. The window 'storage' event fires across tabs but
// NOT within the same tab — emit a CustomEvent of our own so same-tab
// changes (e.g. LoginScreen → App) refresh too.
const EVENT_NAME = 'boson:guest:change';

export function emitGuestChange(): void {
  if (typeof globalThis === 'undefined') return;
  const w = globalThis as { dispatchEvent?: (e: Event) => boolean };
  if (typeof CustomEvent === 'undefined' || !w.dispatchEvent) return;
  try { w.dispatchEvent(new CustomEvent(EVENT_NAME)); } catch { /* best-effort */ }
}

export function onGuestChange(fn: () => void): () => void {
  if (typeof globalThis === 'undefined') return () => {};
  const w = globalThis as {
    addEventListener?: (t: string, l: EventListener) => void;
    removeEventListener?: (t: string, l: EventListener) => void;
  };
  if (!w.addEventListener || !w.removeEventListener) return () => {};
  const listener = (): void => fn();
  w.addEventListener(EVENT_NAME, listener);
  return () => w.removeEventListener?.(EVENT_NAME, listener);
}
