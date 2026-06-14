import { useEffect, useState } from 'preact/hooks';
import { createPortal } from 'preact/compat';
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
  // CDN URL of the server's directory icon, when the owner set one. Shown
  // in place of the initials tile; absent → initials fallback.
  iconUrl?: string;
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
  // Disconnect + drop the named server from the active session AND the
  // saved-session set (i.e. it won't re-restore next launch). Wired to
  // the "Leave server" item in the right-click menu. Optional: when
  // absent, the menu item is hidden.
  onLeaveServer?: (serverId: string) => void;
}

// ServerRail renders one tile per connected server, plus a `+` button that
// opens the directory modal. When `servers` is provided the rail is fully
// multi-tile (Discord/Slack-style); otherwise it falls back to a single-tile
// view driven by `activeServerName` for legacy callers.
export function ServerRail({
  servers, activeServerId, activeServerName, onSelectServer, onBrowseServers, onOpenServerSettings, onLeaveServer,
}: ServerRailProps) {
  // Right-click context menu state. Anchored to the tile, positioned at the
  // event's client coords so the menu pops up under the cursor.
  const [menu, setMenu] = useState<{ serverId: string; x: number; y: number } | null>(null);
  const handleContextMenu = (e: MouseEvent, serverId: string): void => {
    if (!onOpenServerSettings && !onLeaveServer) return;
    e.preventDefault();
    setMenu({ serverId, x: e.clientX, y: e.clientY });
  };
  const closeMenu = (): void => setMenu(null);
  // Hover name-flyout: the full server name shown beside the hovered tile.
  // position:fixed (set from the tile's rect) so the narrow, overflow-clipped
  // rail doesn't cut it off.
  const [hovered, setHovered] = useState<{ name: string; top: number; left: number } | null>(null);
  const tiles: ServerRailTile[] = servers && servers.length > 0
    ? Array.from(servers)
    : activeServerName
      ? [{ serverId: '__legacy', name: activeServerName, engineState: 'connected' }]
      : [];

  return (
    <>
    <nav class="server-rail" aria-label="Servers">
      {tiles.map((t) => {
        const isActive = (activeServerId ?? '__legacy') === t.serverId;
        // Icon when the owner set one; otherwise the initials tile. alt="" —
        // the tile's title/aria already names the server, so the image is
        // decorative and shouldn't be announced twice.
        const face = t.iconUrl
          ? <img class="server-item-icon" src={t.iconUrl} alt="" />
          : serverInitials(t.name);
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
          t.iconUrl ? 'server-item-has-icon' : '',
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
        // Hover name-flyout. The rail clips horizontal overflow (overflow-y
        // auto coerces overflow-x), so the tooltip can't be a normal child —
        // we render ONE position:fixed bubble (below) positioned from the
        // hovered tile's rect.
        const showName = (e: MouseEvent): void => {
          const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
          // Center the flyout on the tile's vertical midpoint; the CSS
          // translateY(-50%) does the rest. left = just past the tile's right edge.
          setHovered({ name: `${t.name}${titleSuffix}`, top: r.top + r.height / 2, left: r.right + 8 });
        };
        const hideName = (): void => setHovered(null);
        // Single legacy tile is rendered as a div for backward compatibility
        // with existing tests that don't expect it to be a button. The
        // multi-tile case always uses a button so it's keyboard-clickable.
        if (servers && onSelectServer) {
          return (
            <button
              type="button"
              key={t.serverId}
              class={cls}
              // No native `title` — the custom hover flyout below is the
              // tooltip. (A title here showed a SECOND, off-centre popup.)
              aria-label={`${t.name}${titleSuffix}`}
              aria-current={isActive ? 'true' : undefined}
              onClick={() => onSelectServer(t.serverId)}
              onContextMenu={(e) => handleContextMenu(e, t.serverId)}
              onMouseEnter={showName}
              onMouseLeave={hideName}
            >
              {face}
              {badge}
            </button>
          );
        }
        return (
          <div
            key={t.serverId}
            class={cls}
            aria-label={t.name}
            aria-current={isActive ? 'true' : undefined}
            onContextMenu={(e) => handleContextMenu(e, t.serverId)}
            onMouseEnter={showName}
            onMouseLeave={hideName}
          >
            {face}
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

      {menu && (
        <ServerRailContextMenu
          x={menu.x}
          y={menu.y}
          onClose={closeMenu}
          onDetails={onOpenServerSettings ? () => { onOpenServerSettings(menu.serverId); closeMenu(); } : undefined}
          onLeave={onLeaveServer ? () => { onLeaveServer(menu.serverId); closeMenu(); } : undefined}
        />
      )}
    </nav>
    {hovered && createPortal(
      <div
        class="server-rail-tooltip"
        role="tooltip"
        // `top` is the tile's vertical centre; CSS translateY(-50%) pulls the
        // bubble up by half its own height so it sits centred beside the tile.
        // Portaled to <body> so position:fixed resolves against the viewport —
        // an ancestor with `transform` would otherwise offset it (verified).
        style={`top: ${hovered.top}px; left: ${hovered.left}px;`}
      >
        {hovered.name}
      </div>,
      document.body,
    )}
    </>
  );
}

// Right-click menu that anchors at the event coordinates. Closes on
// outside-click or Escape. Renders into the rail's relative-positioned
// nav so the menu stays anchored to the page while scrolling the rail.
interface ServerRailContextMenuProps {
  x: number;
  y: number;
  onClose: () => void;
  onDetails?: () => void;
  onLeave?: () => void;
}

function ServerRailContextMenu({ x, y, onClose, onDetails, onLeave }: ServerRailContextMenuProps) {
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
      {onDetails && (
        <button type="button" class="server-rail-context-item" role="menuitem" onClick={onDetails}>
          Server details
        </button>
      )}
      {onLeave && (
        <button
          type="button"
          class="server-rail-context-item server-rail-context-item-danger"
          role="menuitem"
          onClick={onLeave}
        >
          Leave server
        </button>
      )}
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
