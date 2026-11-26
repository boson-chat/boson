// How conversations read: preferences that follow the account (see
// prefs-sync). Persisted to localStorage; changes broadcast via a same-tab
// CustomEvent so the message view and the settings screen react.

const STORAGE_KEY = 'boson:chat-display:v1';

export interface ChatDisplaySettings {
  // A line that only starts with `nick:` is shown as a reply to that
  // person's latest message (a guess, in a lighter style).
  guessedReplies: boolean;
}

export const DEFAULT_CHAT_DISPLAY: ChatDisplaySettings = {
  guessedReplies: true,
};

interface Storage {
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
}
function getStorage(): Storage | null {
  try { return (globalThis as { localStorage?: Storage }).localStorage ?? null; } catch { return null; }
}

let cached: ChatDisplaySettings | null = null;

export function getChatDisplaySettings(): ChatDisplaySettings {
  if (cached) return cached;
  let next = { ...DEFAULT_CHAT_DISPLAY };
  try {
    const raw = getStorage()?.getItem(STORAGE_KEY);
    if (raw) {
      const p = JSON.parse(raw) as Partial<ChatDisplaySettings>;
      next = { guessedReplies: typeof p.guessedReplies === 'boolean' ? p.guessedReplies : next.guessedReplies };
    }
  } catch { /* keep defaults */ }
  cached = next;
  return next;
}

export function setChatDisplaySettings(patch: Partial<ChatDisplaySettings>): void {
  const next = { ...getChatDisplaySettings(), ...patch };
  cached = next;
  try { getStorage()?.setItem(STORAGE_KEY, JSON.stringify(next)); } catch { /* best-effort */ }
  emitChange();
}

const EVENT_NAME = 'boson:chat-display:change';
function emitChange(): void {
  const w = globalThis as { dispatchEvent?: (e: Event) => boolean };
  if (typeof CustomEvent === 'undefined' || !w.dispatchEvent) return;
  try { w.dispatchEvent(new CustomEvent(EVENT_NAME)); } catch { /* best-effort */ }
}

export function onChatDisplaySettingsChange(fn: () => void): () => void {
  const w = globalThis as {
    addEventListener?: (t: string, l: EventListener) => void;
    removeEventListener?: (t: string, l: EventListener) => void;
  };
  if (!w.addEventListener || !w.removeEventListener) return () => {};
  const l = (): void => fn();
  w.addEventListener(EVENT_NAME, l);
  return () => w.removeEventListener?.(EVENT_NAME, l);
}

// Test seam (and prefs-sync, after applying a synced copy).
export function __resetChatDisplaySettingsCache(): void { cached = null; }
