// Opens the user settings modal at a section from anywhere (e.g. the voice
// bar's gear opens Voice). app.tsx listens.

type Listener = (section: string) => void;
const listeners = new Set<Listener>();

export function openUserSettings(section: string): void {
  listeners.forEach((fn) => fn(section));
}

export function onOpenUserSettings(fn: Listener): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}
