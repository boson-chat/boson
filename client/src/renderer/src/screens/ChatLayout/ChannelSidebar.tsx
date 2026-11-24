import { Fragment, type ComponentChildren } from 'preact';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { createPortal } from 'preact/compat';
import type { ChatChannel, ServerInfo } from '../../modules/chat';
import type { EngineState } from '../../modules/engine';
import { ArrowLeftRight, MoreHorizontal, Plus, Settings } from 'lucide-preact';
import { Button, Count, EmptyState, Input, Modal, StatusDot, type DotStatus } from '@boson/shared';
import {
  ChannelSidebarBloc,
  type ChannelSidebarState,
} from './ChannelSidebarBloc';
import { useChannelReorder, type ReorderSection } from './channel-reorder';
import { NickContextMenu, type NickContextAction } from './NickContextMenu';
import { getChannelLevel, setChannelLevel, type ChannelLevel } from '../../modules/ui/notifications.store';
import { BottomSheet } from './BottomSheet';
import { ADMINS_ONLY_TEXT, type ChannelCreation } from '../../modules/chanserv/creation';
import { isNarrow, useNarrow } from '../../shared/narrow';
import { Avatar } from '../../shared/Avatar/Avatar';
import { getAvatar } from '../../modules/chat/avatar-cache';
import { useRevealCurrent } from '../../shared/reveal-current';
import './ChannelSidebar.css';
import './ChannelReorder.css';

interface ChannelSidebarProps {
  serverName: string;
  // CDN URL of the server's wide (3:1) banner, when the owner set one. Shown
  // as a header strip with the server name + gear overlaid; absent → the
  // plain text header.
  bannerUrl?: string;
  // The network's logo (network themes), beside the server name.
  logoUrl?: string;
  channels: ChatChannel[];
  activeChannel: string | null;
  onSelect: (name: string) => void;
  onJoin: (name: string) => void;
  onPart: (name: string) => void;
  // The DM section's "All": every server's direct messages (in You).
  onOpenAllDms?: () => void;
  // The user's own order for this server's list (channel keys; see
  // modules/session/channel-order.ts), applied within each section.
  channelOrder?: readonly string[];
  // A section was reordered (drag, Alt+Up/Down, Move up / down): its names,
  // top to bottom. Without it the rows don't reorder.
  onReorderChannels?: (names: string[]) => void;
  // The server's id: each channel's Notifications (All / Mentions /
  // Nothing) in its menu are kept per server.
  serverId?: string | null;
  // "Reset order": back to the default order.
  onResetChannelOrder?: () => void;
  // Server-advertised channel directory (from RPL_LIST). Powers the Join
  // modal's autocomplete. Optional — when absent or empty the modal still
  // works as a plain text input.
  channelDirectory?: ReadonlyArray<{ name: string; userCount: number; topic: string }>;
  // Who may create channels here (auth /v1/config channel_creation). When
  // creation is admins-only and the user isn't one, the Join modal says so
  // and offers the network's channels instead.
  creation?: ChannelCreation | null;
  // Click handler for the gear button next to the server name. Opens the
  // full-page ServerSettings view for the active server. Button is hidden
  // when not provided.
  onOpenSettings?: () => void;
  // Daemon/version + bouncer info (from RPL_MYINFO) shown under the server name.
  serverInfo?: ServerInfo;
  // Connection state, drives the status dot under the server name.
  engineState?: EngineState;
  // User-set width (px) from the drag handle; falls back to the CSS default.
  width?: number;
  // The VOICE section under the channels (servers with voice), and what
  // sits at the foot of the list (the voice-connected bar).
  voice?: ComponentChildren;
  footer?: ComponentChildren;
  // Under the header: the network account line (NetworkAccountBar).
  account?: ComponentChildren;
  // A text channel's voice channels, shown under its row (Discord style),
  // and an extra button on the row (the voice "+").
  channelVoice?: (channel: string) => ComponentChildren;
  channelAction?: (channel: string) => ComponentChildren;
  // The server's directory description: under its name in place of the
  // daemon's version (which stays in the tooltip).
  serverDescription?: string;
  // Bumped to open the channel browser (the welcome's "Browse all channels").
  openJoinRequest?: number;
}

export function ChannelSidebar({
  serverName,
  bannerUrl,
  logoUrl,
  channels,
  activeChannel,
  onSelect,
  onJoin,
  onPart,
  onOpenAllDms,
  channelOrder,
  onReorderChannels,
  serverId,
  onResetChannelOrder,
  channelDirectory,
  creation,
  onOpenSettings,
  serverInfo,
  engineState = 'connected',
  width,
  voice,
  footer,
  account,
  channelVoice,
  channelAction,
  serverDescription,
  openJoinRequest = 0,
}: ChannelSidebarProps) {
  // Ref-backed view of the channels prop so the bloc always reads the latest
  // list without us rebuilding it on every render. Same pattern as ChatArea
  // uses for members / knownChannels.
  const channelsRef = useRef<readonly ChatChannel[]>(channels);
  channelsRef.current = channels;
  const onJoinRef = useRef(onJoin);
  onJoinRef.current = onJoin;
  const orderRef = useRef(channelOrder);
  orderRef.current = channelOrder;

  const narrow = useNarrow();
  const bloc = useMemo(
    () =>
      new ChannelSidebarBloc({
        getChannels: () => channelsRef.current,
        getOrder: () => orderRef.current,
        onJoin: (name) => onJoinRef.current(name),
      }),
    [],
  );

  // When the channels prop identity changes (parent re-rendered with a new
  // list), poke the bloc so it re-derives groupings and re-emits to
  // subscribers. The bloc itself doesn't cache the list — this is just the
  // signal that derived state should refresh.
  // The saved order is re-read from storage on each render, so compare it
  // by value.
  const orderSig = channelOrder?.join('\n') ?? '';
  useEffect(() => {
    bloc.notifyChannelsChanged();
  }, [channels, orderSig, bloc]);

  useEffect(() => { if (openJoinRequest > 0) bloc.openJoinModal(); }, [openJoinRequest, bloc]);

  const [state, setState] = useState<ChannelSidebarState>(() => bloc.getState());
  useEffect(() => bloc.subscribe(setState), [bloc]);

  const { joinModalOpen, joinDraft, joinError, realChannels, dms, customOrder } = state;

  // Reordering (drag, touch hold-and-drag, Alt+Up/Down, the row menu).
  const sections = {
    channels: realChannels.map((c) => c.name),
    dms: dms.map((c) => c.name),
  };
  const [rowMenu, setRowMenu] = useState<
    { name: string; section: ReorderSection; at: { x: number; y: number } | null } | null
  >(null);
  const reorder = useChannelReorder({
    enabled: !!onReorderChannels && state.query.trim() === '',
    sections,
    onReorder: (_section, names) => onReorderChannels?.(names),
    onHold: (name, section) => {
      if (rowMenuActions(name, section).length > 0) setRowMenu({ name, section, at: null });
    },
  });
  const rowMenuActions = (name: string, section: ReorderSection): NickContextAction[] => {
    const names = sections[section];
    const i = names.indexOf(name);
    const actions: NickContextAction[] = [];
    if (i > 0) actions.push({ label: 'Move up', onClick: () => reorder.step(name, section, -1) });
    if (i !== -1 && i < names.length - 1) actions.push({ label: 'Move down', onClick: () => reorder.step(name, section, 1) });
    if (customOrder && onResetChannelOrder) actions.push({ label: 'Reset order', onClick: onResetChannelOrder });
    if (serverId) {
      const level = getChannelLevel(serverId, name);
      const pick = (l: ChannelLevel) => () => setChannelLevel(serverId, name, l);
      actions.push(
        { label: 'Notifications: All messages', checked: level === 'all', onClick: pick('all') },
        { label: 'Notifications: Mentions only', checked: level === 'mentions', onClick: pick('mentions') },
        { label: 'Notifications: Nothing', checked: level === 'nothing', onClick: pick('nothing') },
      );
    }
    // Leaving lives here (not as an × on the row, one slip from a click):
    // the toast that follows offers Undo.
    actions.push({ label: section === 'dms' ? 'Close conversation' : 'Leave channel', danger: true, onClick: () => onPart(name) });
    return actions;
  };
  // Right-click a row (desktop): its menu. Phones get it from the long
  // press (the reorder sheet), or a plain long press without reordering.
  const rowMenu_ = (name: string, section: ReorderSection) => (e: MouseEvent): void => {
    if ((e as PointerEvent).pointerType === 'touch' || isNarrow()) { if (onReorderChannels) e.preventDefault(); return; }
    if (rowMenuActions(name, section).length === 0) return;
    e.preventDefault();
    setRowMenu({ name, section, at: { x: e.clientX, y: e.clientY } });
  };
  // The row's "…" (desktop hover): the same menu, under the button.
  const moreMenu = (name: string, section: ReorderSection) => (e: MouseEvent): void => {
    e.stopPropagation();
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setRowMenu({ name, section, at: { x: r.left, y: r.bottom } });
  };
  const rowReorder = (name: string, section: ReorderSection): RowReorder | undefined => {
    if (!onReorderChannels) return undefined;
    const ind = reorder.indicator(name, section);
    return {
      attrs: reorder.row(name, section),
      dragging: reorder.drag?.name === name,
      drop: ind,
      onMenu: (e) => {
        // A touch hold is the drag (and its sheet); Android also raises
        // contextmenu for it.
        if ((e as PointerEvent).pointerType === 'touch' || isNarrow()) { e.preventDefault(); return; }
        if (rowMenuActions(name, section).length === 0) return;
        e.preventDefault();
        setRowMenu({ name, section, at: { x: e.clientX, y: e.clientY } });
      },
    };
  };
  // Compact daemon label under the server name (e.g. "ngircd-27"); network +
  // hostname stay in the title tooltip rather than crowding the sidebar.
  const daemon = serverInfo?.version ?? serverInfo?.serverName ?? '';
  const serverMeta = serverDescription?.trim() || daemon;
  // On a bouncer link, engine 'connected' only means the bouncer is reachable;
  // whether the bouncer is attached to the real network is `bouncerUpstream`.
  // A configured bouncer whose upstream isn't reported yet is still being
  // worked out: "connecting", not "Connected". The engine's status frame
  // reaches this view synchronously, while the chat state (where the
  // upstream report lands) is emitted on a timer, so right after the 001
  // the two disagree for a render or more.
  const upstream = engineState === 'connected' && serverInfo?.bouncer
    ? serverInfo.bouncerUpstream ?? (serverInfo.bouncerConfigured ? 'connecting' : undefined)
    : undefined;
  const statusLabel = engineState === 'connecting' ? 'Connecting…'
    : engineState !== 'connected' ? 'Disconnected'
      : upstream === 'disconnected' ? 'Bouncer connected · network offline'
        : upstream === 'connecting' ? 'Bouncer connected · network connecting…'
          : 'Connected';
  // Dot colour: an offline upstream reads as a warning (amber), a pending
  // one as connecting; otherwise mirror the engine state.
  const dotState = upstream === 'disconnected' ? 'upstream-offline'
    : upstream === 'connecting' ? 'connecting'
      : engineState;
  const metaTooltip = [
    serverDescription?.trim() ? daemon : '',
    serverInfo?.serverName,
    serverInfo?.network ? `Network: ${serverInfo.network}` : '',
    serverInfo?.bouncer && !upstream ? 'Connected via bouncer' : '',
    statusLabel,
  ].filter(Boolean).join('\n');
  // The synthetic `~server` channel is intentionally not rendered here —
  // service / NickServ messages live behind the Server details modal,
  // surfaced via the version badge in the chat header.

  // Open on the channel you're in, not the top of the list.
  const asideRef = useRef<HTMLElement>(null);
  useRevealCurrent(asideRef, '.channel-list', '.channel-item-active');
  return (
    <aside ref={asideRef} class="channel-sidebar" aria-label="Channels" style={width ? { width: `${width}px` } : undefined}>
      <div
        class={`channel-sidebar-header ${bannerUrl ? 'channel-sidebar-header-banner' : ''}`}
        style={bannerUrl ? `background-image: url("${cssUrl(bannerUrl)}")` : undefined}
      >
        {logoUrl && <img class="channel-sidebar-logo" src={logoUrl} alt="" draggable={false} />}
        <div class="channel-sidebar-heading">
          <div class="channel-sidebar-title sidebar-server-name">{serverName}</div>
          {(serverMeta || serverInfo?.bouncer) && (
            <div class="sidebar-server-meta" title={metaTooltip}>
              <span class="sidebar-status-dot" data-state={dotState} role="img" aria-label={statusLabel}>
                <StatusDot status={DOT_STATUS[dotState] ?? 'online'} />
              </span>
              {serverMeta && <span class="sidebar-server-version">{serverMeta}</span>}
              {serverInfo?.bouncer && (
                <ArrowLeftRight
                  class="sidebar-bnc"
                  size={12}
                  data-upstream={upstream}
                  aria-label={upstream === 'disconnected' ? 'via bouncer, network offline'
                    : upstream === 'connecting' ? 'via bouncer, network connecting' : 'via bouncer'}
                />
              )}
            </div>
          )}
        </div>
        {onOpenSettings && (
          <Button
            variant="ghost"
            size={narrow ? 'lg' : 'sm'}
            class="channel-sidebar-settings"
            aria-label="Server details"
            title="Server details"
            onClick={onOpenSettings}
            icon={<Settings aria-hidden="true" />}
          />
        )}
      </div>

      {account}

      <div
        class={`channel-list${reorder.drag ? ' channel-list-reordering' : ''}`}
        ref={reorder.list.ref}
        onDragOver={reorder.list.onDragOver}
        onDrop={reorder.list.onDrop}
      >
        {realChannels.length === 0 && dms.length === 0 && (
          <EmptyState
            class="channel-empty"
            action={<Button variant="secondary" size={narrow ? 'lg' : 'sm'} onClick={() => bloc.openJoinModal()}>Browse channels</Button>}
          >
            No channels joined yet.
          </EmptyState>
        )}

        <div class="channel-section-header">
          <div class="channel-section">Channels</div>
          <Button
            variant="ghost"
            size={narrow ? 'lg' : 'sm'}
            class="channel-add"
            aria-label="Add channel"
            title={creation?.restricted ? 'Join a channel' : 'Join a new channel'}
            onClick={() => bloc.openJoinModal()}
            icon={<Plus aria-hidden="true" />}
          />
        </div>
        {realChannels.map((c) => (
          <Fragment key={c.name}>
            <ChannelRow
              channel={c}
              active={c.name === activeChannel}
              onSelect={onSelect}
              prefix="#"
              action={channelAction?.(c.name)}
              reorder={rowReorder(c.name, 'channels')}
              onMenu={rowMenu_(c.name, 'channels')}
              onMore={moreMenu(c.name, 'channels')}
            />
            {channelVoice?.(c.name)}
          </Fragment>
        ))}

        {dms.length > 0 && (
          <>
            <div class="channel-section-header">
              <div class="channel-section">Direct Messages</div>
              {onOpenAllDms && (
                <Button variant="ghost" size="sm" class="channel-section-link" onClick={onOpenAllDms}
                  aria-label="All direct messages" title="Every server's direct messages, in You">All</Button>
              )}
            </div>
            {dms.map((c) => (
              <ChannelRow
                key={c.name}
                channel={c}
                active={c.name === activeChannel}
                onSelect={onSelect}
                prefix=""
                leading={<Avatar nick={c.name} url={serverId ? getAvatar(serverId, c.name) : undefined} size={20} />}
                reorder={rowReorder(c.name, 'dms')}
                onMenu={rowMenu_(c.name, 'dms')}
                onMore={moreMenu(c.name, 'dms')}
              />
            ))}
          </>
        )}

        {voice}
        <div class="channel-reorder-status" role="status" aria-live="polite">{reorder.announce}</div>
      </div>

      {reorder.ghost && reorder.drag && createPortal(
        <div
          class="channel-reorder-ghost"
          aria-hidden="true"
          style={`top: ${reorder.ghost.y}px; left: ${reorder.ghost.x}px;`}
        >
          {reorder.drag.name}
        </div>,
        document.body,
      )}

      {rowMenu?.at && (
        <NickContextMenu
          x={rowMenu.at.x}
          y={rowMenu.at.y}
          title={rowMenu.name}
          actions={rowMenuActions(rowMenu.name, rowMenu.section)}
          onClose={() => setRowMenu(null)}
        />
      )}
      {rowMenu && !rowMenu.at && (
        <BottomSheet
          label={rowMenu.name}
          header={<div class="channel-reorder-sheet-title">{rowMenu.name}</div>}
          actions={rowMenuActions(rowMenu.name, rowMenu.section)}
          onClose={() => setRowMenu(null)}
        />
      )}

      {footer}

      <Modal open={joinModalOpen} onClose={() => bloc.closeJoinModal()} title={creation?.restricted ? 'Join a channel' : 'Join or create a channel'}>
        <JoinChannelBrowser
          draft={joinDraft}
          directory={channelDirectory}
          creation={creation}
          joined={realChannels}
          error={joinError}
          onDraftChange={(v) => bloc.setJoinDraft(v)}
          onSubmit={() => bloc.submitJoin()}
          onPick={(name) => {
            bloc.setJoinDraft(name);
            bloc.submitJoin();
          }}
          onCancel={() => bloc.closeJoinModal()}
        />
      </Modal>
    </aside>
  );
}

// The header's connection dot: an offline or pending bouncer upstream
// reads as a warning; otherwise the engine state.
const DOT_STATUS: Record<string, DotStatus> = {
  connected: 'online',
  connecting: 'away',
  'upstream-offline': 'away',
  disconnected: 'error',
};

// Escape a URL for safe interpolation into a CSS url("...") value: neutralise
// the closing quote, backslash, and parens so a crafted banner URL can't break
// out of the declaration. The URL itself is backend-issued (our CDN), but we
// don't trust it into a style string unescaped.
export function cssUrl(url: string): string {
  return url.replace(/[\\"()]/g, '\\$&');
}

interface ChannelRowProps {
  channel: ChatChannel;
  active: boolean;
  prefix: string;
  // In place of the prefix (a DM's avatar).
  leading?: ComponentChildren;
  onSelect: (name: string) => void;
  action?: ComponentChildren;
  reorder?: RowReorder;
  // Right-click: the row's menu.
  onMenu?: (e: MouseEvent) => void;
  // The hover "…": the same menu.
  onMore?: (e: MouseEvent) => void;
}

// A row's part in reordering: its drag attributes / handlers, whether it's
// the one being dragged, where the drop line shows on it, and its menu.
interface RowReorder {
  attrs: ReturnType<ReturnType<typeof useChannelReorder>['row']>;
  dragging: boolean;
  drop: 'before' | 'after' | null;
  onMenu: (e: MouseEvent) => void;
}

// How far a channel has got since we asked to be in it: `joining` until the
// server confirms the JOIN, `loading` until the member list has arrived (it
// follows the JOIN), then `ready`. Members' away status and details come from
// a WHO that's paced behind every other channel's — up to a minute on a
// bouncer with many channels — and fill in when they land, so they don't
// hold the channel up. DMs are always ready.
export type ChannelSync = 'joining' | 'failed' | 'loading' | 'ready';

export function channelSync(channel: ChatChannel): ChannelSync {
  if (!/^[#&]/.test(channel.name)) return 'ready';
  if (!channel.joined) return channel.joinStatus?.state === 'failed' ? 'failed' : 'joining';
  if (channel.namesLoaded === false) return 'loading';
  return 'ready';
}

const SYNC_TITLE: Record<ChannelSync, string | undefined> = {
  joining: 'Joining…',
  failed: "Couldn't join — tap to try again",
  loading: 'Loading members…',
  ready: undefined,
};

function ChannelRow({ channel, active, prefix, leading, onSelect, action, reorder, onMenu, onMore }: ChannelRowProps) {
  const display = channel.name.replace(/^[#&]/, '');
  const sync = channelSync(channel);
  // Unread badge: hidden when active (counters get cleared anyway) or when
  // the count is 0. `mentions` is a subset of `unread`; if any mention sits
  // unread, the badge takes the accent (amber) treatment.
  const showBadge = !active && channel.unread > 0;
  const hasMention = channel.mentions > 0;
  const { onReorderKey, ...reorderAttrs } = (reorder?.attrs ?? {}) as RowReorder['attrs'] & {
    onReorderKey?: (e: KeyboardEvent) => boolean;
  };
  const reorderCls = reorder
    ? `${reorder.dragging ? ' channel-item-dragging' : ''}${reorder.drop ? ` channel-item-drop-${reorder.drop}` : ''}`
    : '';
  return (
    <div
      {...reorderAttrs}
      class={`channel-item ${active ? 'channel-item-active' : ''} ${showBadge ? 'channel-item-unread' : ''} ${hasMention ? 'channel-item-mention' : ''}${reorderCls}`}
      data-sync={sync}
      title={SYNC_TITLE[sync]}
      aria-busy={sync === 'ready' || sync === 'failed' ? undefined : true}
      aria-keyshortcuts={onReorderKey ? 'Alt+ArrowUp Alt+ArrowDown' : undefined}
      onClick={() => onSelect(channel.name)}
      onContextMenu={onMenu ?? reorder?.onMenu}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (onReorderKey?.(e)) return;
        if (e.key === 'Enter' || e.key === ' ') onSelect(channel.name);
      }}
    >
      {leading ? <span class="channel-lead">{leading}</span> : (
        <span class="channel-hash">
          {sync === 'ready' || sync === 'failed' ? prefix : <span class="channel-sync-spinner" data-sync={sync} aria-hidden="true" />}
        </span>
      )}
      <span class="channel-name">{display}</span>
      {hasMention ? (
        <Count
          value={channel.mentions}
          class="channel-mention-count"
          label={`${channel.mentions} mention${channel.mentions === 1 ? '' : 's'} in ${channel.name}`}
        />
      ) : showBadge ? (
        <StatusDot
          status="unread"
          class="channel-unread-dot"
          label={`${channel.unread} unread message${channel.unread === 1 ? '' : 's'} in ${channel.name}`}
        />
      ) : null}
      {action}
      {onMore && (
        <Button
          variant="ghost"
          size="sm"
          class="channel-more"
          title="More"
          aria-label={`More for ${channel.name}`}
          aria-haspopup="menu"
          onClick={onMore}
          icon={<MoreHorizontal aria-hidden="true" />}
        />
      )}
    </div>
  );
}

// Search-driven channel browser shown inside the Join modal. The search box
// at the top filters the server-advertised directory (RPL_LIST) by substring
// match against channel name AND topic. Up/Down arrows move the highlight;
// Enter joins either the highlighted row or — when no row matches — the
// literal value typed (so unlisted channels are still reachable).
interface JoinChannelBrowserProps {
  draft: string;
  directory?: ReadonlyArray<{ name: string; userCount: number; topic: string }>;
  creation?: ChannelCreation | null;
  // Channels we're in (not suggested again).
  joined?: ReadonlyArray<{ name: string; joined?: boolean }>;
  error: string | null;
  onDraftChange: (v: string) => void;
  onSubmit: () => void;
  onPick: (name: string) => void;
  onCancel: () => void;
}

const JOIN_PAGE_SIZE = 50;

function JoinChannelBrowser({
  draft, directory, creation, joined, error, onDraftChange, onSubmit, onPick, onCancel,
}: JoinChannelBrowserProps) {
  const restricted = !!creation?.restricted;
  // Admins-only creation: the network's channels, as something to join.
  const suggestions = useMemo(() => {
    if (!restricted) return [];
    const have = new Set((joined ?? []).filter((c) => c.joined !== false).map((c) => c.name.toLowerCase()));
    return (creation?.channels ?? []).filter((c) => !have.has(c.name.toLowerCase()));
  }, [restricted, creation, joined]);
  // Nothing is highlighted until the arrow keys (or the mouse) pick a
  // row: Enter / the main button act on what was typed, not on whatever
  // happened to be first in the list.
  const [highlight, setHighlight] = useState(-1);
  const [page, setPage] = useState(0);
  const listRef = useRef<HTMLDivElement | null>(null);

  const needle = draft.trim().replace(/^[#&]/, '').toLowerCase();
  const all = directory ?? [];
  // Filter the full directory by name OR topic substring. Big networks ship
  // tens of thousands of channels — the loop is cheap (one .includes() per
  // entry) and we want to paginate over the full matched set, not a cap.
  const matches = useMemo(() => {
    if (needle.length === 0) return all;
    return all.filter((c) => {
      const nameMatch = c.name.toLowerCase().replace(/^[#&]/, '').includes(needle);
      if (nameMatch) return true;
      return c.topic.toLowerCase().includes(needle);
    });
  }, [all, needle]);

  const totalPages = Math.max(1, Math.ceil(matches.length / JOIN_PAGE_SIZE));
  // Reset page + highlight when the result set changes (new query etc).
  useEffect(() => {
    setPage(0);
    setHighlight(-1);
  }, [needle, all.length]);
  // Keep page in bounds if matches shrink underneath us.
  useEffect(() => {
    setPage((p) => Math.min(p, totalPages - 1));
  }, [totalPages]);

  const start = page * JOIN_PAGE_SIZE;
  const visible = matches.slice(start, start + JOIN_PAGE_SIZE);

  // Keep the highlight inside the visible page.
  useEffect(() => {
    setHighlight((h) => (visible.length === 0 ? -1 : Math.min(h, visible.length - 1)));
  }, [visible.length]);

  // The typed name as a channel, and whether the list has it.
  const typedName = draft.trim() ? (/^[#&]/.test(draft.trim()) ? draft.trim() : `#${draft.trim()}`) : '';
  const exact = typedName ? matches.find((c) => c.name.toLowerCase() === typedName.toLowerCase()) : undefined;
  const listKnown = all.length > 0;
  // A name that isn't in the list: creating it (it may be hidden or the
  // list not in yet, so "join or create" until we know).
  const offerCreate = !!typedName && !exact && !restricted && !/\s/.test(typedName);
  const picked = highlight >= 0 ? visible[highlight] : undefined;
  const act = (): void => {
    if (picked) onPick(picked.name);
    else if (exact) onPick(exact.name);
    else if (draft.trim()) onSubmit();
  };
  const actLabel = picked ? `Join ${picked.name}`
    : exact ? `Join ${exact.name}`
      : typedName ? (offerCreate && listKnown ? `Create ${typedName}` : `Join ${typedName}`)
        : 'Join';

  // Scroll the highlighted row into view as the user arrow-keys through.
  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const row = list.querySelector<HTMLElement>(`[data-idx="${highlight}"]`);
    if (row) row.scrollIntoView({ block: 'nearest' });
  }, [highlight]);

  const goPrev = (): void => {
    if (page <= 0) return;
    setPage(page - 1);
    setHighlight(0);
  };
  const goNext = (): void => {
    if (page >= totalPages - 1) return;
    setPage(page + 1);
    setHighlight(0);
  };

  const onKeyDown = (e: KeyboardEvent): void => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (visible.length === 0) return;
      if (highlight < 0) {
        setHighlight(0);
      } else if (highlight === visible.length - 1 && page < totalPages - 1) {
        // Cross-page navigation: roll forward to the first row of next page.
        goNext();
      } else {
        setHighlight((h) => (h + 1) % visible.length);
      }
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (visible.length === 0) return;
      if (highlight <= 0 && page === 0) {
        // Back up to the typed name.
        setHighlight(-1);
      } else if (highlight === 0 && page > 0) {
        // Roll backward — land on the LAST row of the previous page.
        setPage(page - 1);
        setHighlight(JOIN_PAGE_SIZE - 1);
      } else {
        setHighlight((h) => (h - 1 + visible.length) % visible.length);
      }
    } else if (e.key === 'PageDown') {
      e.preventDefault();
      goNext();
    } else if (e.key === 'PageUp') {
      e.preventDefault();
      goPrev();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      act();
    } else if (e.key === 'Escape') {
      onCancel();
    }
  };

  const headerLabel = directory === undefined || directory.length === 0
    ? 'Channel list not in yet — type a channel name and press Enter.'
    : needle === ''
      ? `${all.length.toLocaleString()} channels`
      : `${matches.length.toLocaleString()} match${matches.length === 1 ? '' : 'es'} for "${needle}"`;

  return (
    <div class="channel-join-browser" onKeyDown={onKeyDown}>
      <div class="channel-join-search">
        <Input
          placeholder={restricted ? 'Search channels by name or topic' : 'Search channels, or type a new #name to create it'}
          aria-label="Channel name"
          value={draft}
          onInput={(e) => onDraftChange((e.target as HTMLInputElement).value)}
          autoFocus
          autoComplete="off"
          spellcheck={false}
        />
        {error && <div class="channel-join-error" role="alert">{error}</div>}
        {restricted && (
          <p class="channel-join-note" data-testid="channel-create-restricted">
            {ADMINS_ONLY_TEXT} You can join channels that already exist.
          </p>
        )}
        {suggestions.length > 0 && (
          <div class="channel-join-suggestions" role="group" aria-label="Network channels">
            {suggestions.map((c) => (
              <Button
                key={c.name}
                variant="secondary"
                size="sm"
                class="channel-join-suggestion"
                title={c.topic || c.name}
                onClick={() => onPick(c.name)}
              >
                {c.name}
              </Button>
            ))}
          </div>
        )}
      </div>

      {offerCreate && (
        <button type="button" class="channel-join-create" onClick={onSubmit}>
          <Plus aria-hidden="true" class="channel-join-create-icon" />
          <span class="channel-join-create-label">
            {listKnown ? <>Create <strong>{typedName}</strong></> : <>Join or create <strong>{typedName}</strong></>}
          </span>
        </button>
      )}

      <div class="channel-join-results-head">{headerLabel}</div>

      <div class="channel-join-results" ref={listRef} role="listbox">
        {visible.length === 0 ? (
          <EmptyState class="channel-join-empty">
            {directory === undefined || directory.length === 0
              ? 'Waiting for the server to publish its channel list…'
              : restricted
                ? 'No channels match. Only admins can create new channels here.'
                : 'No channels match.'}
          </EmptyState>
        ) : (
          visible.map((c, idx) => (
            <button
              key={c.name}
              type="button"
              role="option"
              aria-selected={idx === highlight}
              data-idx={idx}
              class={`channel-join-result ${idx === highlight ? 'channel-join-result-active' : ''}`}
              onClick={() => onPick(c.name)}
              // A mouse only: on a touch screen iOS replays a tap as
              // mouseenter first, and a re-render there makes it swallow
              // the tap (the user had to tap twice to join).
              onPointerEnter={(e) => { if (e.pointerType === 'mouse') setHighlight(idx); }}
              title={c.topic || c.name}
            >
              <span class="channel-join-result-name">{c.name}</span>
              <span class="channel-join-result-users">
                {c.userCount.toLocaleString()} {c.userCount === 1 ? 'user' : 'users'}
              </span>
              {c.topic && (
                <span class="channel-join-result-topic">{c.topic}</span>
              )}
            </button>
          ))
        )}
      </div>

      {totalPages > 1 && (
        <div class="channel-join-pagination" aria-label="Channel list pagination">
          <Button
            variant="secondary"
            size="sm"
            onClick={goPrev}
            disabled={page === 0}
            aria-label="Previous page"
          >
            ‹ Prev
          </Button>
          <span class="channel-join-page-status">
            Page {page + 1} of {totalPages.toLocaleString()}
            <span class="channel-join-page-range">
              {' '}({(start + 1).toLocaleString()}–{Math.min(start + JOIN_PAGE_SIZE, matches.length).toLocaleString()} of {matches.length.toLocaleString()})
            </span>
          </span>
          <Button
            variant="secondary"
            size="sm"
            onClick={goNext}
            disabled={page >= totalPages - 1}
            aria-label="Next page"
          >
            Next ›
          </Button>
        </div>
      )}

      <div class="channel-join-actions">
        <Button variant="ghost" type="button" onClick={onCancel}>Cancel</Button>
        <Button
          variant="primary"
          type="button"
          disabled={!picked && !draft.trim()}
          onClick={act}
        >
          {actLabel}
        </Button>
      </div>
    </div>
  );
}
