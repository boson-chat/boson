import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { ChatChannel, ServerInfo, ServerLogEntry } from '../../modules/chat';
import type { EngineState } from '../../modules/engine';
import { ChatInputBloc, type ChatInputState } from './ChatInputBloc';
import { ChatInputBar } from './ChatInputBar';
import { MessageList } from './message-render';
import type { NickActions } from './UserPanel';
import './ChatArea.css';

interface ChatAreaProps {
  channel: ChatChannel | null;
  myNick: string;
  knownChannels?: string[];
  onSend: (message: string) => void;
  bannerError?: string | null;
  onDismissBanner?: () => void;
  // Per-server engine state, so the chat area can render a connecting splash
  // / disconnected splash without relying on the server rail to communicate
  // it. Defaults to 'connected' to keep the legacy test fixtures intact:
  // anywhere the prop is omitted (ChatLayout.test.tsx, etc.) the view
  // behaves as it did before the engine-state wiring landed.
  engineState?: EngineState;
  // Active server's display name. Used in the connecting / disconnected
  // splash text ("Connecting to {name}…"). Falls back to a generic label.
  serverName?: string;
  // Re-issue connect() for the active server. Wired through ChatLayout to
  // DirectoryBloc.reconnectActive(); the chat area only sees an opaque
  // callback so it remains testable in isolation.
  onReconnect?: () => void;
  // Rolling buffer of recent raw engine events. Surfaced only as a small
  // live tail inside the connecting / disconnected splashes; the full log
  // lives in the Server settings screen (right-click a server-rail tile).
  serverLog?: ReadonlyArray<ServerLogEntry>;
  // Most recent engine/IRC error for this connection. Rendered inside the
  // disconnected splash so users see *why* a session dropped (e.g. an IRC
  // 432 ERR_ERRONEUSNICKNAME or a TCP reset) instead of a bare "Disconnected".
  connectionError?: string | null;
  // IRCv3 typing emitter — `'active'` on each non-empty keystroke (ChatService
  // throttles internally), `'done'` on send / clear. Omitted when the host
  // doesn't wire typing (tests, archive-only views), in which case the bloc
  // skips the side-effect entirely.
  onTyping?: (state: 'active' | 'done') => void;
  // Server-software metadata captured from 004 / 005. Rendered as a small
  // `solanum 1.0-dev · Libera.Chat` badge in the chat header. Click to view
  // more comes from a different entry — the ServerRail context menu.
  serverInfo?: ServerInfo;
  // Action callbacks forwarded to MessageList → MessageRow. Wired into the
  // right-click nick context menu (Copy/Send/Mention/Ignore).
  nickActions?: NickActions;
}

export function ChatArea({
  channel,
  myNick,
  knownChannels = [],
  onSend,
  bannerError,
  onDismissBanner,
  engineState = 'connected',
  serverName,
  onReconnect,
  serverLog = [],
  connectionError,
  onTyping,
  serverInfo,
  nickActions,
}: ChatAreaProps) {
  const scrollRef = useRef<HTMLDivElement | null>(null);

  // Refs around the latest props so the bloc — which is constructed once
  // per onSend identity — always sees the freshest member / channel lists
  // without forcing a bloc rebuild on every render.
  const membersRef = useRef<readonly { nick: string }[]>(channel?.members ?? []);
  membersRef.current = channel?.members ?? [];
  const knownChannelsRef = useRef<readonly string[]>(knownChannels);
  knownChannelsRef.current = knownChannels;
  const onSendRef = useRef(onSend);
  onSendRef.current = onSend;
  const onTypingRef = useRef(onTyping);
  onTypingRef.current = onTyping;

  // Bloc is the single source of truth for input/popup state. We re-use
  // the same instance across renders; the closures above ensure it always
  // reads current props. Rebuilding on every render would lose any
  // in-flight cycle state (mention/nick/etc).
  const bloc = useMemo(
    () =>
      new ChatInputBloc({
        getMembers: () => membersRef.current,
        getKnownChannels: () => knownChannelsRef.current,
        onSend: (lines) => {
          for (const line of lines) onSendRef.current(line);
        },
        onTyping: (state) => onTypingRef.current?.(state),
      }),
    [],
  );

  const [state, setState] = useState<ChatInputState>(() => bloc.getState());
  useEffect(() => bloc.subscribe(setState), [bloc]);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [channel?.messages.length, channel?.name]);

  // Connection-loading state: engine is mid-handshake. We render a centred
  // panel with a pulsing dot, the destination label, and a live tail of the
  // last few engine events so users can see progress (NOTICE / RPL_WELCOME /
  // MOTD lines streaming in). The log-panel toggle is still available so a
  // dev can inspect the full handshake if they want.
  if (engineState === 'connecting') {
    return (
      <main class="chat-area chat-area-engine">
        <EngineHeader title="Connecting" serverName={serverName} />
        <div class="chat-engine-splash">
          <div class="chat-engine-dot chat-engine-dot-pulse" />
          <div class="chat-engine-title">
            Connecting to {serverName ?? 'server'}…
          </div>
          <ServerLogTail entries={serverLog} />
        </div>
      </main>
    );
  }

  // Engine is disconnected — show a centred panel offering a reconnect.
  if (engineState === 'disconnected') {
    return (
      <main class="chat-area chat-area-engine">
        <EngineHeader title="Disconnected" serverName={serverName} />
        <div class="chat-engine-splash">
          <div class="chat-engine-dot chat-engine-dot-down" />
          <div class="chat-engine-title">
            Disconnected from {serverName ?? 'server'}
          </div>
          {connectionError && (
            <div class="chat-engine-reason" role="alert">{connectionError}</div>
          )}
          {onReconnect && (
            <button
              type="button"
              class="chat-engine-reconnect"
              onClick={onReconnect}
            >
              Reconnect
            </button>
          )}
          <ServerLogTail entries={serverLog} />
        </div>
      </main>
    );
  }

  // Engine is connected (or idle, which only happens before any connect
  // call) and no active channel — render the existing stub.
  if (!channel) {
    return (
      <main class="chat-area chat-area-empty">
        <div class="chat-area-empty-state">
          <p>Select a channel from the sidebar, or join one to start chatting.</p>
        </div>
      </main>
    );
  }

  const display = channel.name.replace(/^[#&]/, '');
  const prefix = channel.name.startsWith('#') || channel.name.startsWith('&') ? '#' : '@';

  return (
    <main class="chat-area">
      <div class="chat-header">
        <div class="chat-header-left">
          <span class="chat-channel-hash">{prefix}</span>
          <span class="chat-channel-label">{display}</span>
          {channel.topic && (
            <span
              class="chat-channel-topic"
              title={channel.topic}
              aria-label={`Topic: ${channel.topic}`}
            >
              {channel.topic}
            </span>
          )}
        </div>
        <div class="chat-header-right">
          <ServerInfoBadge info={serverInfo} />
          <div class="chat-status">
            <span class="status-dot" />
            <span>connected</span>
          </div>
        </div>
      </div>

      <MessageList
        messages={channel.messages}
        members={channel.members}
        myNick={myNick}
        scrollRef={scrollRef}
        nickActions={nickActions}
      />

      <TypingIndicator nicks={channel.typing} />

      <ChatInputBar
        state={state}
        bloc={bloc}
        placeholder={`Message ${prefix}${display}`}
        bannerError={bannerError}
        onDismissBanner={onDismissBanner}
      />
    </main>
  );
}

// Small "via solanum 1.0-dev · Libera.Chat" badge in the chat header.
// Renders nothing until we've seen 004 RPL_MYINFO at least once; many test
// fixtures and the connecting splash don't have any info yet, so the badge
// hides gracefully. The full hostname (e.g. "hub.example.org") is tucked into
// a `title` tooltip rather than the visible label — that detail is rarely
// useful but worth keeping reachable.
interface ServerInfoBadgeProps {
  info: ServerInfo | undefined;
}

function ServerInfoBadge({ info }: ServerInfoBadgeProps) {
  if (!info) return null;
  const { serverName, version, network, enabledCaps } = info;
  if (!serverName && !version && !network && (!enabledCaps || enabledCaps.length === 0)) return null;
  const left = version ?? serverName;
  const parts: string[] = [];
  if (left) parts.push(left);
  if (network) parts.push(network);
  const tooltipLines: string[] = [];
  if (serverName) tooltipLines.push(serverName);
  if (enabledCaps && enabledCaps.length > 0) {
    tooltipLines.push(`IRCv3 caps: ${enabledCaps.join(', ')}`);
  } else {
    tooltipLines.push('IRCv3 caps: (none ACKed yet)');
  }
  tooltipLines.push('Right-click a server tile for details');
  return (
    <span class="chat-server-info" title={tooltipLines.join('\n')}>
      {parts.join(' · ')}
    </span>
  );
}

// "Alice is typing", "Alice and Bob are typing", "Several people are typing".
// Always rendered; CSS handles the fade in/out via the `data-active` attribute
// so the input bar position is stable. Bounded at 3 names; beyond that we
// collapse to "several people".
interface TypingIndicatorProps {
  nicks: readonly string[];
}

function TypingIndicator({ nicks }: TypingIndicatorProps) {
  const active = nicks.length > 0;
  let label = '';
  if (nicks.length === 1) label = nicks[0] + ' is typing';
  else if (nicks.length === 2) label = nicks[0] + ' and ' + nicks[1] + ' are typing';
  else if (nicks.length === 3) label = nicks[0] + ', ' + nicks[1] + ' and ' + nicks[2] + ' are typing';
  else if (nicks.length > 3) label = 'Several people are typing';
  return (
    <div
      class="chat-typing"
      aria-live="polite"
      aria-hidden={!active}
      data-active={active ? '1' : '0'}
    >
      <span class="chat-typing-bubble" aria-hidden="true">
        <span class="chat-typing-dot" />
        <span class="chat-typing-dot" />
        <span class="chat-typing-dot" />
      </span>
      <span class="chat-typing-text">{label}</span>
    </div>
  );
}

// Shared header for the connecting / disconnected splashes. Keeps the chat
// shell's visual rhythm (border-bottom, padding) consistent with the active-
// channel header.
interface EngineHeaderProps {
  title: string;
  serverName: string | undefined;
}

function EngineHeader({ title, serverName }: EngineHeaderProps) {
  return (
    <div class="chat-header">
      <div class="chat-header-left">
        <span class="chat-channel-label">{title}</span>
        {serverName && <span class="chat-engine-server-name">{serverName}</span>}
      </div>
    </div>
  );
}

// Live tail of the last few captured engine events, surfaced inside the
// connecting / disconnected splash so users see something is happening even
// before they think to open the full log panel. Capped to the last N entries
// to keep the splash from filling the viewport during MOTD bursts.
const TAIL_SIZE = 10;

interface ServerLogTailProps {
  entries: ReadonlyArray<ServerLogEntry>;
}

function ServerLogTail({ entries }: ServerLogTailProps) {
  if (entries.length === 0) return null;
  const tail = entries.slice(-TAIL_SIZE);
  return (
    <div class="chat-engine-tail" aria-label="Recent engine events">
      {tail.map((e) => (
        <div key={e.id} class="chat-engine-tail-row">
          <span class="chat-engine-tail-kind">{e.kind || '—'}</span>
          <span class="chat-engine-tail-message">
            {e.message || e.target || e.from || ''}
          </span>
        </div>
      ))}
    </div>
  );
}

