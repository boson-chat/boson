import { useEffect, useState } from 'preact/hooks';
import { getNetworkThemes, type NetworkBranding, type NetworkThemes } from './network-themes';

// Re-renders whenever any network's theme, image or switch changes; returns
// the store (read brandingFor() etc. during render).
export function useNetworkThemes(store: NetworkThemes = getNetworkThemes()): NetworkThemes {
  const [, setTick] = useState(0);
  useEffect(() => store.subscribe(() => setTick((n) => n + 1)), [store]);
  return store;
}

// One network's branding (logo, sign-in background, switches). host null:
// none.
export function useNetworkBranding(host: string | null | undefined, store: NetworkThemes = getNetworkThemes()): NetworkBranding | null {
  const themes = useNetworkThemes(store);
  return host ? themes.brandingFor(host) : null;
}
