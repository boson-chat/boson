import { useEffect, useMemo, useState } from 'preact/hooks';
import type { ChatService, ChatState } from '../../modules/chat';
import { banMask } from '../../modules/chat';
import type { EngineState } from '../../modules/engine';
import { Modal } from '@boson/shared';
import { ServerRail, type ServerRailTile } from './ServerRail';
import { ChannelSidebar } from './ChannelSidebar';
import { ChatArea } from './ChatArea';
import { UserPanel } from './UserPanel';
import { ChannelSettings } from './ChannelSettings';
import { ResizeHandle } from './ResizeHandle';
import { getPanelWidth, setPanelWidth, PANEL_BOUNDS } from '../../modules/ui/panel-sizes';
import type { ChannelOpActions } from './nick-actions';
import { useAvatarFor } from '../../shared/Avatar/use-avatar-for';
import { ChatLayoutBloc, type ChatLayoutState } from './ChatLayoutBloc';
import './ChatLayout.css';

interface Props {
  chat: ChatService;
  serverName: string;
  // CDN URL of the active server's wide banner, when the owner set one.
  // Rendered as the ChannelSidebar header strip; absent → plain text header.
  bannerUrl?: string;
  myNick: string;
  // Multi-server tiles. When provided, ServerRail renders one tile per
  // connection and `onSelectServer` switches the active connection. When
  // omitted (or empty), ServerRail falls back to single-tile mode driven by
  // `serverName` — keeps the existing ChatLayout tests/callers working.
  servers?: readonly ServerRailTile[];
  activeServerId?: string | null;
  onSelectServer?: (serverId: string) => void;
  onBrowseServers: () => void;
  // Engine state for the currently-active server. Drives the chat area's
  // connecting / disconnected splash. Optional with a sensible default so
  // existing fixtures don't break — they get the historical 'connected'
  // behaviour.
  engineState?: EngineState;
  // Re-issue connect() for the active server (DirectoryBloc.reconnectActive).
  // Surfaced as a button inside the disconnected splash.
  onReconnect?: () => void;
  // Stop the auto-reconnect cycle for the active server. The bloc fires
  // a reconnect attempt on every drop with backoff; clicking Cancel
  // halts that cycle until the user manually clicks Reconnect.
  onCancelReconnect?: () => void;
  // True while the bloc's auto-reconnect cycle is active for this
  // server. Drives the splash: an active cycle shows a spinner + Cancel
  // button; a non-active cycle (cancelled / never started) shows just
  // the Reconnect button.
  reconnectActive?: boolean;
  // Most recent engine/IRC-level error for the active connection. Surfaced
  // inside the disconnected splash so users see why a session dropped.
  connectionError?: string | null;
  // Right-click a server-rail tile triggers this. The parent (DirectoryScreen)
  // takes over rendering and swaps in the full-page ServerSettings view.
  onOpenServerSettings?: (serverId: string) => void;
  // "Leave server" handler — disconnects + drops the server from the saved
  // session set. Wired into the right-click menu on each server-rail tile.
  onLeaveServer?: (serverId: string) => void;
}

export function ChatLayout({
  chat, serverName, bannerUrl, myNick, servers, activeServerId, onSelectServer, onBrowseServers,
  engineState = 'connected', onReconnect, onCancelReconnect, reconnectActive = false,
  connectionError, onOpenServerSettings, onLeaveServer,
}: Props) {
  // Two sources of truth, both consumed via subscribe():
  //   1. ChatService owns the 4-column UI state (channels, members, log).
  //   2. ChatLayoutBloc owns transient feedback (error banner + help modal).
  const [state, setState] = useState<ChatState>(chat.getState());
  const layoutBloc = useMemo(() => new ChatLayoutBloc({ chat }), [chat]);
  const [layoutState, setLayoutState] = useState<ChatLayoutState>(layoutBloc.getState());

  useEffect(() => chat.subscribe(setState), [chat]);
  useEffect(() => layoutBloc.subscribe(setLayoutState), [layoutBloc]);
  // dispose tears down the chat.onFeedback subscription and clears any
  // pending auto-dismiss timer the bloc may have scheduled.
  useEffect(() => () => layoutBloc.dispose(), [layoutBloc]);

  const active = state.channels.find((c) => c.name === state.activeChannel) ?? null;
  const { bannerError, helpCommands } = layoutState;

  // Kick (and Kick+Ban) collect an optional reason via a small modal before
  // firing. `ban` is whether to also ban (the "Kick + Ban" menu item).
  const [kickTarget, setKickTarget] = useState<{ nick: string; ban: boolean } | null>(null);
  const [kickReason, setKickReason] = useState('');
  // Channel Settings modal open state (gear on the channel header).
  const [channelSettingsOpen, setChannelSettingsOpen] = useState(false);

  // Resizable side panels — initial width from the persisted store (localStorage,
  // which survives restarts + reinstalls), live-updated while dragging.
  const [channelsW, setChannelsW] = useState(() => getPanelWidth('channels'));
  const [membersW, setMembersW] = useState(() => getPanelWidth('members'));

  const isChannel = !!active && (active.name.startsWith('#') || active.name.startsWith('&'));
  const supportsOwnerAdmin = /[qa]/.test(state.serverInfo.prefix?.modes ?? 'qa');
  // Our rank in the active channel. `typeof` guard keeps hand-rolled test fakes
  // (no myRank method) working — they read as rank 0.
  const myRankHere = active && typeof chat.myRank === 'function' ? chat.myRank(active.name) : 0;

  // Action callbacks bound to the right-click nick context menu. Wired
  // to ChatService so both the member panel and the message-row nicks
  // share the same behaviour. `ops` is present only inside a channel and
  // carries the channel-operator actions, gated in the menu by our rank.
  const nickActions = useMemo(() => {
    // `typeof` guard keeps hand-rolled test fakes (no op methods) working —
    // they just get the base menu (copy / DM / mention).
    const ops: ChannelOpActions | undefined = isChannel && active && typeof chat.myRank === 'function' ? {
      myRank: myRankHere,
      prefixOf: (n: string) => active.members.find((m) => m.nick === n)?.prefix ?? '',
      supportsOwnerAdmin,
      op: (n: string, on: boolean) => chat.setMemberMode(active.name, n, on ? '+o' : '-o'),
      halfop: (n: string, on: boolean) => chat.setMemberMode(active.name, n, on ? '+h' : '-h'),
      voice: (n: string, on: boolean) => chat.setMemberMode(active.name, n, on ? '+v' : '-v'),
      admin: (n: string, on: boolean) => chat.setMemberMode(active.name, n, on ? '+a' : '-a'),
      owner: (n: string, on: boolean) => chat.setMemberMode(active.name, n, on ? '+q' : '-q'),
      ban: (n: string) => chat.ban(active.name, banMask(n, active.members.find((m) => m.nick === n)?.hostname)),
      kick: (n: string) => { setKickReason(''); setKickTarget({ nick: n, ban: false }); },
      kickBan: (n: string) => { setKickReason(''); setKickTarget({ nick: n, ban: true }); },
    } : undefined;
    return { onSendMessage: (nick: string) => chat.openDM(nick), ops };
  }, [chat, active, isChannel, supportsOwnerAdmin, myRankHere]);

  // Resolves a nick → profile-image URL for Boson members on this server
  // (own avatar + presence matches), shared by the chat stream + member list.
  const avatarFor = useAvatarFor(activeServerId ?? null);

  return (
    <div class="app-shell">
      <ServerRail
        servers={servers}
        activeServerId={activeServerId}
        activeServerName={serverName}
        onSelectServer={onSelectServer}
        onBrowseServers={onBrowseServers}
        onOpenServerSettings={onOpenServerSettings}
        onLeaveServer={onLeaveServer}
      />
      <ChannelSidebar
        serverName={serverName}
        bannerUrl={bannerUrl}
        channels={state.channels}
        activeChannel={state.activeChannel}
        onSelect={(name) => chat.setActive(name)}
        onJoin={(name) => chat.join(name)}
        onPart={(name) => chat.part(name)}
        channelDirectory={state.channelDirectory.entries}
        onOpenSettings={
          onOpenServerSettings && activeServerId
            ? () => onOpenServerSettings(activeServerId)
            : undefined
        }
        serverInfo={state.serverInfo}
        engineState={engineState}
        width={channelsW}
      />
      <ResizeHandle
        side="left"
        width={channelsW}
        min={PANEL_BOUNDS.channels.min}
        max={PANEL_BOUNDS.channels.max}
        onChange={setChannelsW}
        onCommit={(w) => setChannelsW(setPanelWidth('channels', w))}
        onReset={() => setChannelsW(setPanelWidth('channels', PANEL_BOUNDS.channels.def))}
        ariaLabel="Resize channel list"
      />
      <ChatArea
        channel={active}
        myNick={myNick}
        // Channels available for `#name` autocomplete / `/join` Tab-complete:
        // joined channels first (most relevant), then anything the server
        // advertised via LIST. De-duped, lowercase comparison.
        knownChannels={mergeKnownChannels(state.channels, state.channelDirectory.entries)}
        bannerError={bannerError}
        onDismissBanner={() => layoutBloc.dismissBanner()}
        onSend={(msg) => chat.input(msg)}
        onTyping={(typing) => {
          if (state.activeChannel) chat.sendTyping(state.activeChannel, typing);
        }}
        engineState={engineState}
        serverName={serverName}
        // Active server id + open-settings handler thread through so the
        // pending-confirmation banner (below the chat header) can
        // subscribe to the right credentials entry + jump the user to
        // Advanced → Services on click.
        activeServerId={activeServerId}
        onOpenServerSettings={
          onOpenServerSettings && activeServerId
            ? () => onOpenServerSettings(activeServerId)
            : undefined
        }
        onReconnect={onReconnect}
        onCancelReconnect={onCancelReconnect}
        reconnectActive={reconnectActive}
        connectionError={connectionError}
        serverLog={state.serverLog}
        serverInfo={state.serverInfo}
        nickActions={nickActions}
        avatarFor={avatarFor}
        onLoadOlder={(name) => chat.loadOlderHistory(name)}
        // Live per-channel message signal for fine-grained re-renders. Guard
        // with typeof so hand-rolled test fakes (no messagesSignal) fall back
        // to rendering channel.messages from the snapshot.
        messagesSignal={
          active && typeof chat.messagesSignal === 'function' ? chat.messagesSignal(active.name) : null
        }
        onOpenChannelSettings={isChannel ? () => setChannelSettingsOpen(true) : undefined}
      />
      <ResizeHandle
        side="right"
        width={membersW}
        min={PANEL_BOUNDS.members.min}
        max={PANEL_BOUNDS.members.max}
        onChange={setMembersW}
        onCommit={(w) => setMembersW(setPanelWidth('members', w))}
        onReset={() => setMembersW(setPanelWidth('members', PANEL_BOUNDS.members.def))}
        ariaLabel="Resize member list"
      />
      <UserPanel channel={active} nickActions={nickActions} avatarFor={avatarFor} width={membersW} />

      <Modal
        open={helpCommands !== null}
        onClose={() => layoutBloc.closeHelp()}
        title="Slash commands"
      >
        <div class="help-modal-list">
          {(helpCommands ?? []).map((c) => (
            <div key={c.name} class="help-modal-row">
              <code class="help-modal-usage">{c.usage}</code>
              <span class="help-modal-desc">{c.description}</span>
            </div>
          ))}
          <div class="help-modal-footer">
            Tip: prefix a literal slash with another, e.g. <code>//hi</code> to send "/hi" as a message.
          </div>
        </div>
      </Modal>

      <Modal
        open={!!kickTarget && isChannel}
        onClose={() => setKickTarget(null)}
        title={kickTarget ? `${kickTarget.ban ? 'Kick + Ban' : 'Kick'} ${kickTarget.nick}` : ''}
      >
        {kickTarget && active && (
          <div class="kick-modal">
            <label class="kick-modal-label">
              Reason (optional)
              <input
                class="kick-modal-input"
                value={kickReason}
                onInput={(e) => setKickReason((e.target as HTMLInputElement).value)}
                placeholder="e.g. spamming"
                // eslint-disable-next-line jsx-a11y/no-autofocus
                autofocus
              />
            </label>
            <div class="kick-modal-actions">
              <button type="button" class="kick-modal-cancel" onClick={() => setKickTarget(null)}>Cancel</button>
              <button
                type="button"
                class="kick-modal-confirm"
                onClick={() => {
                  const reason = kickReason.trim() || undefined;
                  if (kickTarget.ban) {
                    chat.kickBan(active.name, kickTarget.nick, active.members.find((m) => m.nick === kickTarget.nick)?.hostname, reason);
                  } else {
                    chat.kick(active.name, kickTarget.nick, reason);
                  }
                  setKickTarget(null);
                }}
              >
                {kickTarget.ban ? 'Kick + Ban' : 'Kick'}
              </button>
            </div>
          </div>
        )}
      </Modal>

      <Modal
        open={channelSettingsOpen && isChannel}
        onClose={() => setChannelSettingsOpen(false)}
        title={active ? `Channel settings — ${active.name}` : ''}
      >
        {active && isChannel && (
          <ChannelSettings
            channel={active}
            myRank={myRankHere}
            onSetMode={(fragment) => chat.setChannelMode(active.name, fragment)}
            onSetTopic={(text) => chat.setTopic(active.name, text)}
            onAddBan={(mask) => chat.ban(active.name, mask)}
            onRemoveBan={(mask) => chat.unban(active.name, mask)}
            onRefresh={() => { chat.requestChannelModes(active.name); chat.requestBanList(active.name); }}
          />
        )}
      </Modal>
    </div>
  );
}

// Merge the user's joined channels with the server-advertised directory into
// a single de-duped name list for autocomplete. Joined channels come first
// so they sort to the top of any cycle; directory entries fill in everything
// else. Match is case-insensitive on the lowercased channel key.
function mergeKnownChannels(
  joined: ReadonlyArray<{ name: string }>,
  directory: ReadonlyArray<{ name: string }>,
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const isChannel = (n: string): boolean => n.startsWith('#') || n.startsWith('&');
  for (const c of joined) {
    if (!isChannel(c.name)) continue;
    const k = c.name.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(c.name);
  }
  for (const c of directory) {
    if (!isChannel(c.name)) continue;
    const k = c.name.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(c.name);
  }
  return out;
}
