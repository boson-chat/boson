// Opens the user settings modal at a section from anywhere (e.g. the voice
// bar's gear opens Voice). app.tsx listens.

// No section: settings' first page.
type Listener = (section: string | null) => void;
const listeners = new Set<Listener>();

export function openUserSettings(section: string | null = null): void {
  listeners.forEach((fn) => fn(section));
}

export function onOpenUserSettings(fn: Listener): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}
