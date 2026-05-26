import { useEffect, useMemo, useState } from 'preact/hooks';
import type { ChatService, ChatState } from '../../modules/chat';
import type { EngineState } from '../../modules/engine';
import { Modal } from '@boson/shared';
import { ServerRail, type ServerRailTile } from './ServerRail';
import { ChannelSidebar } from './ChannelSidebar';
import { ChatArea } from './ChatArea';
import { UserPanel } from './UserPanel';
import { ChatLayoutBloc, type ChatLayoutState } from './ChatLayoutBloc';
import './ChatLayout.css';

interface Props {
  chat: ChatService;
  serverName: string;
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
  // Most recent engine/IRC-level error for the active connection. Surfaced
  // inside the disconnected splash so users see why a session dropped.
  connectionError?: string | null;
  // Right-click a server-rail tile triggers this. The parent (DirectoryScreen)
  // takes over rendering and swaps in the full-page ServerSettings view.
  onOpenServerSettings?: (serverId: string) => void;
}

export function ChatLayout({
  chat, serverName, myNick, servers, activeServerId, onSelectServer, onBrowseServers,
  engineState = 'connected', onReconnect, connectionError, onOpenServerSettings,
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

  return (
    <div class="app-shell">
      <ServerRail
        servers={servers}
        activeServerId={activeServerId}
        activeServerName={serverName}
        onSelectServer={onSelectServer}
        onBrowseServers={onBrowseServers}
        onOpenServerSettings={onOpenServerSettings}
      />
      <ChannelSidebar
        serverName={serverName}
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
        onReconnect={onReconnect}
        connectionError={connectionError}
        serverLog={state.serverLog}
        serverInfo={state.serverInfo}
      />
      <UserPanel channel={active} />

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
