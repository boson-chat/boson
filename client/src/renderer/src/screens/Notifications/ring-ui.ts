import { useEffect, useState } from 'preact/hooks';

// An incoming call shown as a banner that was opened full screen (tapping
// the banner): those ids show full screen until they stop ringing.
let expanded = new Set<string>();
const listeners = new Set<() => void>();

export function expandRing(id: string): void {
  if (expanded.has(id)) return;
  expanded = new Set(expanded).add(id);
  listeners.forEach((fn) => fn());
}

export function isRingExpanded(id: string): boolean { return expanded.has(id); }

export function useRingExpanded(id: string | null): boolean {
  const [, bump] = useState(0);
  useEffect(() => {
    const fn = (): void => bump((n) => n + 1);
    listeners.add(fn);
    return () => { listeners.delete(fn); };
  }, []);
  return !!id && expanded.has(id);
}
