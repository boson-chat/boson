import { useState, useLayoutEffect } from 'preact/hooks';
import { createPortal } from 'preact/compat';
import type { BouncerUpstreamState, EngineState } from '../../modules/engine';
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
  // Bouncer connections only: whether the bouncer is connected to the real
  // network. Null/absent for direct connections (and until reported).
  // Drives the "Connect / Disconnect network" context-menu items.
  bouncerUpstream?: BouncerUpstreamState | null;
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
  // Ask a bouncer server's bouncer to connect / disconnect its upstream
  // network. Shown in the context menu only for tiles that report a
  // `bouncerUpstream` state.
  onBouncerConnect?: (serverId: string) => void;
  onBouncerDisconnect?: (serverId: string) => void;
  // Tiles can be dragged into a new order; called with every tile's server
  // id, top to bottom, after a drop that moved one. Without it tiles don't drag.
  onReorderServers?: (serverIds: string[]) => void;
}

// Where a dragged tile will land: beside `serverId`, above it or below it.
interface DropTarget { serverId: string; after: boolean }

// The rail's order after dropping `dragged` beside `target`.
export function reorderedIds(ids: readonly string[], dragged: string, target: DropTarget): string[] {
  const rest = ids.filter((id) => id !== dragged);
  const at = rest.indexOf(target.serverId);
  if (at === -1 || rest.length === ids.length) return [...ids];
  rest.splice(target.after ? at + 1 : at, 0, dragged);
  return rest;
}

// ServerRail renders one tile per connected server, plus a `+` button that
// opens the directory modal. When `servers` is provided the rail is fully
// multi-tile (Discord/Slack-style); otherwise it falls back to a single-tile
// view driven by `activeServerName` for legacy callers.
export function ServerRail({
  servers, activeServerId, activeServerName, onSelectServer, onBrowseServers, onOpenServerSettings, onLeaveServer,
  onBouncerConnect, onBouncerDisconnect, onReorderServers,
}: ServerRailProps) {
  // Right-click context menu state. Anchored to the tile, positioned at the
  // event's client coords so the menu pops up under the cursor.
  const [menu, setMenu] = useState<{ serverId: string; x: number; y: number } | null>(null);
  const handleContextMenu = (e: MouseEvent, serverId: string): void => {
    if (!onOpenServerSettings && !onLeaveServer && !onBouncerConnect && !onBouncerDisconnect) return;
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

  // Drag to reorder. `dragging` is the tile being moved; `drop` is where it
  // would land, shown as a line between tiles. The tiles stay put until the
  // drop, so nothing jumps around under the pointer.
  const [dragging, setDragging] = useState<string | null>(null);
  const [drop, setDrop] = useState<DropTarget | null>(null);
  const canReorder = !!(servers && onSelectServer && onReorderServers) && tiles.length > 1;
  const endDrag = (): void => { setDragging(null); setDrop(null); };
  const dragOverTile = (e: DragEvent, serverId: string): void => {
    if (!dragging) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const after = e.clientY > r.top + r.height / 2;
    if (drop?.serverId !== serverId || drop.after !== after) setDrop({ serverId, after });
  };
  const onRailDragOver = (e: DragEvent): void => {
    // Between tiles and on the + button: keep the move cursor; the line
    // stays where the last tile put it (the + button puts it at the end).
    if (!dragging) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
  };
  const onRailDrop = (e: DragEvent): void => {
    if (!dragging) return;
    e.preventDefault();
    const ids = tiles.map((t) => t.serverId);
    const next = drop ? reorderedIds(ids, dragging, drop) : ids;
    endDrag();
    if (next.some((id, i) => id !== ids[i])) onReorderServers?.(next);
  };

  return (
    <>
    <nav
      class={`server-rail${dragging ? ' server-rail-dragging' : ''}`}
      aria-label="Servers"
      onDragOver={onRailDragOver}
      onDrop={onRailDrop}
    >
      {tiles.map((t) => {
        const isActive = (activeServerId ?? '__legacy') === t.serverId;
        // Icon when the owner set one; otherwise the initials tile. alt="" —
        // the tile's title/aria already names the server, so the image is
        // decorative and shouldn't be announced twice.
        const face = t.iconUrl
          ? <img class="server-item-icon" src={t.iconUrl} alt="" draggable={false} />
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
          dragging === t.serverId ? 'server-item-dragging' : '',
          drop?.serverId === t.serverId && dragging !== t.serverId
            ? (drop.after ? 'server-item-drop-after' : 'server-item-drop-before')
            : '',
        ].filter(Boolean).join(' ');
        // A bouncer tile whose bouncer is up but not attached to the network
        // reads "connected" by engine state alone — say what's really going on.
        const titleSuffix = t.engineState !== 'connected'
          ? ` (${t.engineState})`
          : t.bouncerUpstream === 'disconnected'
            ? ' (network offline)'
            : t.bouncerUpstream === 'connecting'
              ? ' (network connecting)'
              : '';
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
              draggable={canReorder}
              onDragStart={canReorder ? (e) => {
                if (e.dataTransfer) {
                  e.dataTransfer.effectAllowed = 'move';
                  e.dataTransfer.setData('text/x-boson-server', t.serverId);
                }
                setHovered(null);
                setMenu(null);
                setDragging(t.serverId);
              } : undefined}
              onDragOver={(e) => dragOverTile(e, t.serverId)}
              onDragEnd={endDrag}
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
        onDragOver={() => {
          const last = tiles[tiles.length - 1];
          if (dragging && last && !(drop?.serverId === last.serverId && drop.after)) {
            setDrop({ serverId: last.serverId, after: true });
          }
        }}
        aria-label="Browse / switch servers"
      >
        +
      </button>

      {menu && (() => {
        const tile = tiles.find((t) => t.serverId === menu.serverId);
        const upstream = tile?.engineState === 'connected' ? tile.bouncerUpstream ?? null : null;
        return (
        <ServerRailContextMenu
          x={menu.x}
          y={menu.y}
          onClose={closeMenu}
          onDetails={onOpenServerSettings ? () => { onOpenServerSettings(menu.serverId); closeMenu(); } : undefined}
          onLeave={onLeaveServer ? () => { onLeaveServer(menu.serverId); closeMenu(); } : undefined}
          onBouncerConnect={upstream === 'disconnected' && onBouncerConnect
            ? () => { onBouncerConnect(menu.serverId); closeMenu(); }
            : undefined}
          onBouncerDisconnect={(upstream === 'connected' || upstream === 'connecting') && onBouncerDisconnect
            ? () => { onBouncerDisconnect(menu.serverId); closeMenu(); }
            : undefined}
        />
        );
      })()}
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
  onBouncerConnect?: () => void;
  onBouncerDisconnect?: () => void;
}

function ServerRailContextMenu({
  x, y, onClose, onDetails, onLeave, onBouncerConnect, onBouncerDisconnect,
}: ServerRailContextMenuProps) {
  // Layout effect: the listeners are in place before the menu is painted,
  // so an Escape or outside click right after it appears isn't missed.
  useLayoutEffect(() => {
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
      {onBouncerConnect && (
        <button type="button" class="server-rail-context-item" role="menuitem" onClick={onBouncerConnect}>
          Connect network
        </button>
      )}
      {onBouncerDisconnect && (
        <button type="button" class="server-rail-context-item" role="menuitem" onClick={onBouncerDisconnect}>
          Disconnect network
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
