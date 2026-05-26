import { useEffect, useState } from 'preact/hooks';
import type { EngineState } from '../../modules/engine';
import './ServerRail.css';

export interface ServerRailTile {
  serverId: string;
  name: string;
  engineState: EngineState;
  // Aggregated unread / mention counts across all channels in this server.
  // Drives the tile's notification dot + accent treatment. Optional so
  // legacy callers that don't compute them still render fine.
  unread?: number;
  mentions?: number;
}

interface ServerRailProps {
  servers?: readonly ServerRailTile[];
  activeServerId?: string | null;
  // Legacy single-server prop, retained so tests + callers that haven't been
  // migrated to multi-server continue to work. Ignored when `servers` is set.
  activeServerName?: string;
  onSelectServer?: (serverId: string) => void;
  onBrowseServers: () => void;
  // Open the Server settings full-page view for `serverId`. Wired to the
  // tile's contextmenu (right-click) handler. Without it, the context menu
  // doesn't appear and tiles behave as before.
  onOpenServerSettings?: (serverId: string) => void;
}

// ServerRail renders one tile per connected server, plus a `+` button that
// opens the directory modal. When `servers` is provided the rail is fully
// multi-tile (Discord/Slack-style); otherwise it falls back to a single-tile
// view driven by `activeServerName` for legacy callers.
export function ServerRail({
  servers, activeServerId, activeServerName, onSelectServer, onBrowseServers, onOpenServerSettings,
}: ServerRailProps) {
  // Right-click context menu state. Anchored to the tile, positioned at the
  // event's client coords so the menu pops up under the cursor.
  const [menu, setMenu] = useState<{ serverId: string; x: number; y: number } | null>(null);
  const handleContextMenu = (e: MouseEvent, serverId: string): void => {
    if (!onOpenServerSettings) return;
    e.preventDefault();
    setMenu({ serverId, x: e.clientX, y: e.clientY });
  };
  const closeMenu = (): void => setMenu(null);
  const tiles: ServerRailTile[] = servers && servers.length > 0
    ? Array.from(servers)
    : activeServerName
      ? [{ serverId: '__legacy', name: activeServerName, engineState: 'connected' }]
      : [];

  return (
    <nav class="server-rail" aria-label="Servers">
      {tiles.map((t) => {
        const isActive = (activeServerId ?? '__legacy') === t.serverId;
        const initials = serverInitials(t.name);
        const unread = t.unread ?? 0;
        const mentions = t.mentions ?? 0;
        // Notification badge sits in the tile's top-right corner. Active tile
        // doesn't show a badge — switching to it clears the counters anyway.
        const showBadge = !isActive && unread > 0;
        const hasMention = mentions > 0;
        const cls = [
          'server-item',
          isActive ? 'server-item-active' : '',
          `server-item-state-${t.engineState}`,
          showBadge ? 'server-item-unread' : '',
          hasMention ? 'server-item-mention' : '',
        ].filter(Boolean).join(' ');
        const titleSuffix = t.engineState === 'connected' ? '' : ` (${t.engineState})`;
        // Ambient unread = small neutral dot. Mention = amber counter badge
        // with the number. Mentions are louder so they win when both apply.
        const badge = hasMention ? (
          <span
            class="server-item-mention-count"
            aria-label={`${mentions} mention${mentions === 1 ? '' : 's'} in ${t.name}`}
          >
            {mentions > 99 ? '99+' : String(mentions)}
          </span>
        ) : showBadge ? (
          <span
            class="server-item-unread-dot"
            aria-label={`${unread} unread message${unread === 1 ? '' : 's'} in ${t.name}`}
          />
        ) : null;
        // Single legacy tile is rendered as a div for backward compatibility
        // with existing tests that don't expect it to be a button. The
        // multi-tile case always uses a button so it's keyboard-clickable.
        if (servers && onSelectServer) {
          return (
            <button
              type="button"
              key={t.serverId}
              class={cls}
              title={`${t.name}${titleSuffix}\nRight-click for server details`}
              aria-current={isActive ? 'true' : undefined}
              onClick={() => onSelectServer(t.serverId)}
              onContextMenu={(e) => handleContextMenu(e, t.serverId)}
            >
              {initials}
              {badge}
            </button>
          );
        }
        return (
          <div
            key={t.serverId}
            class={cls}
            title={t.name}
            aria-current={isActive ? 'true' : undefined}
            onContextMenu={(e) => handleContextMenu(e, t.serverId)}
          >
            {initials}
            {badge}
          </div>
        );
      })}
      <button
        class="server-item server-item-add"
        type="button"
        title="Browse / switch servers"
        onClick={onBrowseServers}
        aria-label="Browse / switch servers"
      >
        +
      </button>

      {menu && onOpenServerSettings && (
        <ServerRailContextMenu
          x={menu.x}
          y={menu.y}
          onClose={closeMenu}
          onDetails={() => { onOpenServerSettings(menu.serverId); closeMenu(); }}
        />
      )}
    </nav>
  );
}

// Right-click menu that anchors at the event coordinates. Closes on
// outside-click or Escape. Renders into the rail's relative-positioned
// nav so the menu stays anchored to the page while scrolling the rail.
interface ServerRailContextMenuProps {
  x: number;
  y: number;
  onClose: () => void;
  onDetails: () => void;
}

function ServerRailContextMenu({ x, y, onClose, onDetails }: ServerRailContextMenuProps) {
  useEffect(() => {
    const onDown = (e: MouseEvent): void => {
      const t = e.target as HTMLElement | null;
      if (t && t.closest('.server-rail-context-menu')) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  return (
    <div
      class="server-rail-context-menu"
      style={`top: ${y}px; left: ${x}px;`}
      role="menu"
    >
      <button type="button" class="server-rail-context-item" role="menuitem" onClick={onDetails}>
        Server details
      </button>
    </div>
  );
}

function serverInitials(name: string): string {
  const cleaned = name.trim();
  if (!cleaned) return '?';
  const parts = cleaned.split(/[\s.\-_]+/).filter(Boolean);
  if (parts.length >= 2) {
    return (parts[0][0] + parts[1][0]).toUpperCase();
  }
  return cleaned.slice(0, 2).toUpperCase();
}
