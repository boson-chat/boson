import { useEffect, useRef } from 'preact/hooks';
import type { Server } from '../../modules/directory';
import type { EngineState } from '../../modules/engine';
import type { NetworkThemes } from '../../modules/ui/theme';

interface Conn {
  serverId: string;
  server: { hostname: string };
  engineState: EngineState;
}

// Keeps the network themes in step with the connections: each network's
// directory listing theme (the fallback source), a fresh lookup when a
// network connects (its cached theme shows until then), and which network
// is on screen.
export function useNetworkThemeSync<C extends Conn>(
  themes: NetworkThemes,
  connections: readonly C[],
  listingFor: (c: C) => Server | undefined,
  activeHost: string | null,
): void {
  // Every render: cheap (compared inside), and listings load late.
  useEffect(() => {
    for (const c of connections) themes.setListingTheme(c.server.hostname, listingFor(c)?.theme);
  });

  const seen = useRef(new Map<string, EngineState>());
  useEffect(() => {
    const now = new Set<string>();
    for (const c of connections) {
      now.add(c.serverId);
      const prev = seen.current.get(c.serverId);
      if (c.engineState === 'connected' && prev !== 'connected') void themes.refresh(c.server.hostname, { force: true });
      else if (prev === undefined) void themes.refresh(c.server.hostname);
      seen.current.set(c.serverId, c.engineState);
    }
    for (const id of [...seen.current.keys()]) if (!now.has(id)) seen.current.delete(id);
  });

  useEffect(() => { themes.setActive(activeHost); }, [themes, activeHost]);
  useEffect(() => () => themes.setActive(null), [themes]);
}
