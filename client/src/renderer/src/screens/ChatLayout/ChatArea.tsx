import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { signal, type Signal } from '@preact/signals';
import type { ChatChannel, ChatMessage, ServerInfo, ServerLogEntry } from '../../modules/chat';
import {
  getServiceCredentialsStore,
  type AccountStatus,
} from '../../modules/chat/services-credentials';
import type { EngineState } from '../../modules/engine';
import { ChatInputBloc, type ChatInputState } from './ChatInputBloc';
import { ChatInputBar } from './ChatInputBar';
import { MessageList } from './message-render';
import type { NickActions } from './UserPanel';
import './ChatArea.css';

// Re-exported from its own module so message-render.tsx can import the resolver
// without a cycle, while existing tests keep importing it from './ChatArea'.
export { resolveScrollTop } from './scroll-resolve';

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
  // Stop the bloc's auto-reconnect cycle. Rendered as a "Cancel" button
  // alongside Reconnect while `reconnectActive` is true.
  onCancelReconnect?: () => void;
  // True while the bloc's auto-reconnect cycle is running. Drives the
  // disconnected splash: an active cycle shows the spinner + Cancel
  // button; a cancelled / inactive cycle shows just the Reconnect
  // button and the static dot.
  reconnectActive?: boolean;
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
  // Resolve a nick → profile-image URL (Boson members), forwarded to
  // MessageList → MessageRow for the per-message avatar.
  avatarFor?: (nick: string) => string | undefined;
  // Stable id for the active connection. Used by the pending-
  // confirmation banner to subscribe to THIS server's credentials
  // entry. Omit when the host doesn't have a stable id (legacy tests).
  activeServerId?: string | null;
  // Open the active server's Advanced → Services settings. Wired
  // through ChatLayout → DirectoryScreen. The banner's "Open settings"
  // link fires this; if omitted, the banner falls back to a copy-only
  // hint without a click target.
  onOpenServerSettings?: () => void;
  // Request older backlog (IRCv3 chathistory) for the named channel. Wired
  // through ChatLayout → ChatService.loadOlderHistory. Omitted in legacy
  // fixtures, in which case the scrollback affordance simply doesn't show.
  onLoadOlder?: (channel: string) => void;
  // The active channel's live message signal (fine-grained reactivity). When
  // omitted (legacy fixtures/tests), ChatArea falls back to wrapping
  // `channel.messages` in a throwaway signal.
  messagesSignal?: Signal<ChatMessage[]> | null;
  // Opens the Channel Settings modal (modes / bans / topic). Present only for
  // channel targets; absent for DMs / the ~server log.
  onOpenChannelSettings?: () => void;
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
  onCancelReconnect,
  reconnectActive = false,
  serverLog = [],
  connectionError,
  onTyping,
  serverInfo,
  nickActions,
  activeServerId,
  onOpenServerSettings,
  onLoadOlder,
  avatarFor,
  messagesSignal,
  onOpenChannelSettings,
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

  // Message list reactivity is fine-grained via a per-channel signal (so a new
  // message re-renders only this list, not the whole layout). Prefer the live
  // signal supplied by the host; fall back to wrapping the snapshot array for
  // fixtures/tests that only pass `channel`. Scroll management lives in
  // MessageList (it owns the scroll container + re-renders on message change).
  const msgSignal = useMemo(
    () => messagesSignal ?? signal<ChatMessage[]>(channel?.messages ?? []),
    [messagesSignal, channel?.messages],
  );

  // Connecting + disconnected splash. Three visual modes, all routed
  // through the same panel so a state flip (disconnected → connecting
  // → disconnected → connecting → connected) doesn't visually thrash:
  //
  //   1. First-time connect (engineState 'connecting', no auto-reconnect
  //      cycle): "Connecting…" title, pulsing dot, no buttons.
  //   2. Auto-reconnect cycle active (engineState 'connecting' OR
  //      'disconnected', `reconnectActive` true): "Reconnecting…"
  //      title, pulsing dot, Reconnect button (disabled while the
  //      engine is mid-attempt, enabled during the backoff wait so
  //      the user can skip), Cancel button to stop the cycle.
  //   3. Manual mode (engineState 'disconnected', cycle inactive
  //      because the user cancelled or it's the first render after a
  //      clean disconnect): static down-dot, "Disconnected" title,
  //      enabled Reconnect button, no Cancel.
  const showConnectingSplash = engineState === 'connecting';
  const showDisconnectedSplash = engineState === 'disconnected';
  if (showConnectingSplash || showDisconnectedSplash) {
    const isReconnecting = reconnectActive;
    const isAttempting = engineState === 'connecting';
    let title: string;
    let dotClass: string;
    if (isAttempting && !isReconnecting) {
      // First-time connect, no cycle yet.
      title = `Connecting to ${serverName ?? 'server'}…`;
      dotClass = 'chat-engine-dot-pulse';
    } else if (isReconnecting) {
      // Auto-reconnect cycle running — same copy whether we're in
      // 'connecting' (mid-attempt) or 'disconnected' (backoff wait).
      title = `Reconnecting to ${serverName ?? 'server'}…`;
      dotClass = 'chat-engine-dot-pulse';
    } else {
      // Manual mode — cycle inactive, user has to click Reconnect.
      title = `Disconnected from ${serverName ?? 'server'}`;
      dotClass = 'chat-engine-dot-down';
    }
    return (
      <main class="chat-area chat-area-engine">
        <EngineHeader
          title={isReconnecting ? 'Reconnecting' : (isAttempting ? 'Connecting' : 'Disconnected')}
          serverName={serverName}
        />
        <div class="chat-engine-splash">
          <div class={`chat-engine-dot ${dotClass}`} />
          <div class="chat-engine-title">{title}</div>
          {showDisconnectedSplash && connectionError && (
            <div class="chat-engine-reason" role="alert">{connectionError}</div>
          )}
          <div class="chat-engine-actions">
            {/* Reconnect: shown for any disconnected splash and any
                reconnecting-cycle splash. Disabled while the engine is
                actively attempting (a click would be a no-op since
                another connect is already in flight). */}
            {(showDisconnectedSplash || isReconnecting) && onReconnect && (
              <button
                type="button"
                class="chat-engine-reconnect"
                onClick={onReconnect}
                disabled={isAttempting}
              >
                Reconnect
              </button>
            )}
            {/* Cancel: only meaningful while the auto-reconnect cycle
                is running — clicking it stops the cycle and the user
                falls through to the manual-mode splash. */}
            {isReconnecting && onCancelReconnect && (
              <button
                type="button"
                class="chat-engine-cancel"
                onClick={onCancelReconnect}
              >
                Cancel
              </button>
            )}
          </div>
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
          <div class="chat-status" title="Connected">
            <span class="status-dot" />
            <span>connected</span>
          </div>
          {onOpenChannelSettings && (
            <button
              type="button"
              class="chat-icon-btn chat-channel-gear"
              onClick={onOpenChannelSettings}
              title="Channel settings"
              aria-label="Channel settings"
            >
              <GearIcon />
            </button>
          )}
        </div>
      </div>

      <PendingConfirmationBanner
        serverId={activeServerId ?? null}
        serverName={serverName}
        onOpenSettings={onOpenServerSettings}
      />

      <MessageList
        messages={msgSignal}
        members={channel.members}
        myNick={myNick}
        scrollRef={scrollRef}
        nickActions={nickActions}
        channelName={channel.name}
        avatarFor={avatarFor}
        onLoadOlder={onLoadOlder ? () => onLoadOlder(channel.name) : undefined}
        historySupported={!!onLoadOlder && !!serverInfo?.scrollbackAvailable}
        historyLoading={channel.history?.loading}
        historyExhausted={channel.history?.exhausted}
        historyError={channel.history?.error}
      />

      <TypingIndicator nicks={channel.typing} />

      <ChatInputBar
        state={state}
        bloc={bloc}
        placeholder={`Message ${prefix}${display}`}
        bannerError={bannerError}
        onDismissBanner={onDismissBanner}
        myNick={myNick}
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
  const { serverName, version, network, enabledCaps, bouncer } = info;
  // The network name is redundant here (you picked the server), so it's shown
  // only in the tooltip. Visible label is just the daemon version/name, plus a
  // relay glyph when connected through a bouncer.
  const label = version ?? serverName;
  if (!label && !bouncer) return null;
  const tooltipLines: string[] = [];
  if (serverName) tooltipLines.push(serverName);
  if (network) tooltipLines.push(`Network: ${network}`);
  if (bouncer) tooltipLines.push('Connected through a bouncer (server-side history available)');
  tooltipLines.push(enabledCaps && enabledCaps.length > 0
    ? `IRCv3 caps: ${enabledCaps.join(', ')}`
    : 'IRCv3 caps: (none ACKed yet)');
  tooltipLines.push('Right-click a server tile for details');
  return (
    <span class="chat-server-info" title={tooltipLines.join('\n')}>
      {label && <span class="chat-server-info-name">{label}</span>}
      {bouncer && <BouncerIcon />}
    </span>
  );
}

// Gear (channel settings) — line icon so it matches the design system rather
// than an emoji that varies by OS.
function GearIcon() {
  return (
    <svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor"
      stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <circle cx="8" cy="8" r="2.1" />
      <path d="M8 1.6v1.8 M8 12.6v1.8 M1.6 8h1.8 M12.6 8h1.8 M3.5 3.5l1.3 1.3 M11.2 11.2l1.3 1.3 M3.5 12.5l1.3-1.3 M11.2 4.8l1.3-1.3" />
    </svg>
  );
}

// Bouncer = a relay/passthrough; an exchange glyph reads better than the words
// "via bouncer". Tooltip on the parent badge spells it out.
function BouncerIcon() {
  return (
    <svg class="chat-server-bnc" viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor"
      stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-label="via bouncer" role="img">
      <path d="M2.5 5.5h9 M9.5 3.5l2 2-2 2" />
      <path d="M13.5 10.5h-9 M6.5 8.5l-2 2 2 2" />
    </svg>
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

interface PendingConfirmationBannerProps {
  serverId: string | null;
  serverName?: string;
  onOpenSettings?: () => void;
}

// Slim amber strip under the chat header that surfaces when the
// active server's NickServ account is pending email confirmation.
// Subscribes to the credentials store keyed by serverId so it stays
// in sync with the Services panel — opening the inbox / confirming
// elsewhere makes the banner self-dismiss on the next status
// transition.
//
// Renders nothing when serverId is missing or status !=
// pending-confirmation. Lives in ChatArea.tsx (rather than its own
// file) because it's tightly tied to the chat-header layout and
// only used here.
function PendingConfirmationBanner({
  serverId, serverName, onOpenSettings,
}: PendingConfirmationBannerProps) {
  const [status, setStatus] = useState<AccountStatus | undefined>(undefined);
  useEffect(() => {
    if (!serverId) {
      setStatus(undefined);
      return;
    }
    return getServiceCredentialsStore().subscribe(serverId, (creds) => {
      setStatus(creds?.status);
    });
  }, [serverId]);
  if (status !== 'pending-confirmation') return null;
  const where = serverName ? ` on ${serverName}` : '';
  return (
    <div class="chat-pending-confirm-banner" role="status">
      <span class="chat-pending-confirm-icon" aria-hidden="true">✉</span>
      <span class="chat-pending-confirm-text">
        Confirm your registration{where}.
      </span>
      {onOpenSettings && (
        <button
          type="button"
          class="chat-pending-confirm-link"
          onClick={onOpenSettings}
        >
          Open settings
        </button>
      )}
    </div>
  );
}

