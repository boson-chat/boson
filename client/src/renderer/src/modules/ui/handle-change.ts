// The signed-in user renamed their handle (Settings → Identity). The
// directory screen listens and renames them on the servers they're on.

type Listener = (handle: string) => void;
const listeners = new Set<Listener>();

export function emitHandleChange(handle: string): void {
  listeners.forEach((fn) => fn(handle));
}

export function onHandleChange(fn: Listener): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}
