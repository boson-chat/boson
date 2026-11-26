import type { ComponentChildren } from 'preact';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { signal, type Signal } from '@preact/signals';
import { ArrowDown, ArrowLeft, PlugZap, Search, Settings, ShieldAlert, ShieldCheck, ShieldOff, Unplug, Users } from 'lucide-preact';
import { BarLoader, Button, EmptyState, StatusDot } from '@boson/shared';
import { useNarrow } from '../../shared/narrow';
import type { ChatChannel, ChatMessage, SendOptions, ServerInfo, ServerLogEntry } from '../../modules/chat';
import {
  getServiceCredentialsStore,
  type AccountStatus,
} from '../../modules/chat/services-credentials';
import type { EngineState } from '../../modules/engine';
import { ChatInputBloc, type ChatInputState } from './ChatInputBloc';
import { ChatInputBar } from './ChatInputBar';
import { MessageList, excerptOf, type ChatSearchMarks, type ReplyContextSource } from './message-render';
import { UploadSheet, type UploadItem } from './UploadSheet';
import { UploadProgress } from './UploadProgress';
import { getFiles, ircTextBudget, MAX_BATCH_FILES, type FilesUsage } from '../../modules/files';
import { useFileDrop } from '../../shared/FileDrop/file-drop';
import { stripIrcFormatting } from './markdown';
import type { NickActions } from './UserPanel';
import { HeaderMore } from './HeaderMore';
import './ChatArea.css';

// Re-exported from its own module so message-render.tsx can import the resolver
// without a cycle, while existing tests keep importing it from './ChatArea'.
export { resolveScrollTop } from './scroll-resolve';

interface ChatAreaProps {
  channel: ChatChannel | null;
  // Under the channel's header while you're in a call elsewhere: the green
  // in-call strip (InCallStrip).
  callStrip?: ComponentChildren;
  myNick: string;
  knownChannels?: string[];
  // A reply: `opts.replyToId` is the local id of the message the line
  // answers, `opts.replyTo` its msgid when it has one.
  onSend: (message: string, opts?: SendOptions) => void;
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
  // Ask the server for a channel again (ChatService.rejoin).
  onRejoin?: (channel: string) => void;
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
  // Whether the user reads at the bottom of the conversation (memory
  // windows: ChatService.setViewport).
  onViewport?: (channel: string, atBottom: boolean) => void;
  // The active channel's live message signal (fine-grained reactivity). When
  // omitted (legacy fixtures/tests), ChatArea falls back to wrapping
  // `channel.messages` in a throwaway signal.
  messagesSignal?: Signal<ChatMessage[]> | null;
  // Originals of replies that aren't loaded, for the open conversation
  // (fetched on their own: ChatService.replyContext).
  replyContext?: ReplyContextSource | null;
  // Opens the Channel Settings modal (modes / bans / topic). Present only for
  // channel targets; absent for DMs / the ~server log.
  onOpenChannelSettings?: () => void;
  // ChanServ registration of the active channel, when known: a small shield
  // next to its name that opens the Registration tab.
  // `atRisk`: we're an operator of an unregistered channel — say so in
  // words ("Unregistered"), as the ops are lost once everyone leaves.
  registration?: { registered: boolean; founder?: string; atRisk?: boolean } | null;
  // Shown under the header while atRisk until dismissed: register it so it
  // stays yours.
  registerPrompt?: { onRegister: () => void; onDismiss: () => void } | null;
  onOpenRegistration?: () => void;
  // Ask the active server's bouncer to connect its upstream network. Drives
  // the bouncer-upstream strip's [Connect] button; when omitted the strip
  // still shows state but without the action.
  onBouncerConnect?: () => void;
  // Answer the bouncer's "trust this certificate?" prompt
  // (serverInfo.bouncerCert). Without them the strip shows no buttons.
  onTrustBouncerCert?: () => void;
  onRejectBouncerCert?: () => void;
  // Phone layout: back to the rail and channel list, or the member list
  // full screen. Absent on wide layouts.
  onBack?: () => void;
  onShowMembers?: () => void;
  // Shown in place of "Select a channel…" while you're in no channel of
  // this server (ServerWelcome).
  welcome?: ComponentChildren;
  // Not on phones: whether the member list is shown (docked, or at mid
  // width the overlay) and the header toggle for it.
  membersShown?: boolean;
  onToggleMembers?: () => void;
  // The active server's IRC host: file uploads go to its network's files
  // host (none → no attach button).
  serverHost?: string;
  // Sends a message to a given channel of the active server (a finished
  // upload's link, which may land after the user switched channels).
  onSendTo?: (channel: string, message: string) => void;
  // The full-page search (SearchPage): open over the conversation, and the
  // header's Search / Ctrl+F opening it. Without onOpenSearch: no Search.
  searchOpen?: boolean;
  onOpenSearch?: () => void;
  searchPage?: ComponentChildren;
  // A search result opened here: scrolled to, flashed and its match marked,
  // with "Back to results" and "Jump to latest" floating over the list.
  searchJump?: { id: string; seq: number; query: string } | null;
  onBackToResults?: () => void;
  onDismissSearchJump?: () => void;
  // Threads (threads.ts): open one (ThreadPanel, beside or over the
  // conversation) by its root's id; and a message the thread panel asked
  // to be shown in the conversation (scrolled to and flashed).
  onOpenThread?: (rootId: string) => void;
  threadJump?: { id: string; seq: number } | null;
}

function isMac(): boolean {
  return typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
}

// Phones: the back arrow at the start of the header, to the channel list.
function PaneBackButton({ onBack }: { onBack?: () => void }) {
  if (!onBack) return null;
  return (
    <Button variant="ghost" size="lg" class="chat-pane-back" onClick={onBack} aria-label="Back to channels"
      icon={<ArrowLeft aria-hidden="true" />} />
  );
}

export function ChatArea({
  channel,
  callStrip,
  myNick,
  knownChannels = [],
  onSend,
  bannerError,
  onDismissBanner,
  engineState = 'connected',
  serverName,
  onReconnect,
  onRejoin,
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
  onViewport,
  avatarFor,
  messagesSignal,
  replyContext,
  onOpenChannelSettings,
  registration,
  registerPrompt,
  onOpenRegistration,
  onBouncerConnect,
  onTrustBouncerCert,
  onRejectBouncerCert,
  onBack,
  onShowMembers,
  membersShown,
  onToggleMembers,
  welcome,
  serverHost,
  onSendTo,
  searchOpen = false,
  onOpenSearch,
  searchPage,
  searchJump = null,
  onBackToResults,
  onDismissSearchJump,
  onOpenThread,
  threadJump = null,
}: ChatAreaProps) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  // A quick reconnect (an app switch, a network hop) shows nothing; the
  // strip only once it's taking a while — or at once when it needs the
  // user (stopped trying).
  const slowReconnect = useAfter(engineState !== 'connected', STRIP_DELAY_MS);
  const needsUser = engineState === 'disconnected' && !reconnectActive;

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

  // Replying to a message: the composer shows it, and the next line sent
  // answers it — with its msgid (IRCv3 `+draft/reply`) where the server
  // relays client tags, and always with `nick: ` / `nick: "quote..." ` at
  // its start, for clients that don't read the tag (ChatService.send).
  const [replyTarget, setReplyTarget] = useState<ChatMessage | null>(null);
  const replyRef = useRef(replyTarget);
  replyRef.current = replyTarget;

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
          // A reply's tag rides the first line (a paste's later lines
          // follow it as plain lines).
          const reply = replyRef.current;
          lines.forEach((line, i) => {
            if (i === 0 && reply) onSendRef.current(line, { ...(reply.msgid ? { replyTo: reply.msgid } : {}), replyToId: reply.id });
            else onSendRef.current(line);
          });
          if (reply) setReplyTarget(null);
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

  // Mention puts `@nick ` at the front of the input and focuses it, keeping
  // whatever was already typed.
  const rowNickActions = useMemo<NickActions | undefined>(() => {
    if (!nickActions) return undefined;
    const mention = (nick: string): void => {
      const tag = `@${nick} `;
      const input = bloc.getState().input;
      if (!input.startsWith(tag)) bloc.insertAtCursor(tag, 0, 0);
      else bloc.insertAtCursor('', input.length, input.length); // already there: just focus
    };
    return {
      ...nickActions,
      onMention: mention,
      onReply: (m: ChatMessage) => {
        setReplyTarget(m);
        const input = bloc.getState().input;
        bloc.insertAtCursor('', input.length, input.length); // focus the composer
      },
    };
  }, [nickActions, bloc]);

  // ---- search (the full page: SearchPage, over the conversation) ----
  const mainRef = useRef<HTMLElement | null>(null);
  // A result opened here: its row marked (the query highlighted in it).
  const searchMarks = useMemo<ChatSearchMarks | null>(() => (searchJump
    ? { query: searchJump.query, matchIds: new Set([searchJump.id]), currentId: searchJump.id }
    : null), [searchJump]);
  // Jump to latest: back to the bottom of the conversation.
  const [latestSeq, setLatestSeq] = useState(0);
  // The page closed (not to a result): the focus back on the header's Search.
  const searchBtnRef = useRef<HTMLButtonElement>(null);
  const wasSearchOpen = useRef(searchOpen);
  useEffect(() => {
    if (wasSearchOpen.current && !searchOpen && !searchJump) searchBtnRef.current?.focus();
    wasSearchOpen.current = searchOpen;
  }, [searchOpen]);
  // Another conversation: no reply in progress.
  useEffect(() => { setReplyTarget(null); }, [channel?.name]);
  // Ctrl/Cmd+F: search this conversation — unless a dialog is open or the
  // focus is in a field elsewhere (that field's own find, if any).
  const hasChannel = !!channel;
  const openSearchRef = useRef(onOpenSearch);
  openSearchRef.current = onOpenSearch;
  const canSearch = !!onOpenSearch;
  useEffect(() => {
    if (!hasChannel || !canSearch) return undefined;
    const onKey = (e: KeyboardEvent): void => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey || e.key.toLowerCase() !== 'f') return;
      if (document.querySelector('.bds-modal-backdrop, .bds-sheet-backdrop')) return;
      const ae = document.activeElement as HTMLElement | null;
      const editable = !!ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.isContentEditable);
      if (editable && !mainRef.current?.contains(ae)) return;
      e.preventDefault();
      openSearchRef.current?.();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [hasChannel, canSearch]);

  // ---- file uploads ----
  const files = getFiles();
  useEffect(() => { if (serverHost) void files?.ensure(serverHost); }, [files, serverHost]);
  const filesAvail = files && serverHost ? files.availability(serverHost) : null;
  const uploadTarget = channel && channel.name !== '~server' && !channel.name.startsWith('~') ? channel.name : null;
  const canUpload = !!filesAvail?.available && !!uploadTarget && !!onSendTo;
  const [sheetFiles, setSheetFiles] = useState<File[] | null>(null);
  const [sheetNotice, setSheetNotice] = useState<string | undefined>(undefined);
  const [usage, setUsage] = useState<FilesUsage | null | undefined>(undefined);
  const sheetFilesRef = useRef<File[] | null>(null);
  sheetFilesRef.current = sheetFiles;
  // Picked or dropped files: a new sheet, or added to the open one (at most
  // MAX_BATCH_FILES in all).
  const openSheet = (picked: File[]): void => {
    if (!canUpload || !files || !serverHost || picked.length === 0) return;
    const open = sheetFilesRef.current;
    const have = open ?? [];
    const added = picked.slice(0, Math.max(0, MAX_BATCH_FILES - have.length));
    const left = picked.length - added.length;
    setSheetNotice(left > 0
      ? `You can send up to ${MAX_BATCH_FILES} files at once; ${left === 1 ? "1 file wasn't" : `${left} files weren't`} added.`
      : undefined);
    if (added.length === 0 && open) return;
    setSheetFiles([...have, ...added]);
    if (!open) {
      setUsage(undefined);
      void files.usage(serverHost).then((u) => setUsage(u), () => setUsage(null));
    }
  };
  const closeSheet = (): void => {
    setSheetFiles(null);
    setSheetNotice(undefined);
  };
  const narrow = useNarrow();
  const drop = useFileDrop({ disabled: !canUpload, onFiles: openSheet });
  const onSendToRef = useRef(onSendTo);
  onSendToRef.current = onSendTo;
  const sendUploads = (items: UploadItem[], caption: string): void => {
    const target = uploadTarget;
    closeSheet();
    if (!files || !serverHost || !target) return;
    files.uploadBatch({
      host: serverHost,
      channel: target,
      items,
      caption,
      maxTextBytes: ircTextBudget(myNick, target),
      post: (text) => onSendToRef.current?.(target, text),
    });
  };
  const channelUploads = files && serverHost && uploadTarget ? files.uploadsFor(serverHost, uploadTarget) : [];

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
  //
  // Only when there's no conversation to show (a first connect): with a
  // channel open, a dropped connection keeps the conversation on screen
  // under a slim ConnectionStrip — a reconnect (an app switch on a phone,
  // a network blip) shouldn't look like the app reloading.
  const showConnectingSplash = engineState === 'connecting';
  const showDisconnectedSplash = engineState === 'disconnected';
  if ((showConnectingSplash || showDisconnectedSplash) && !channel) {
    const isReconnecting = reconnectActive;
    const isAttempting = engineState === 'connecting';
    let title: string;
    let dotPulse: boolean;
    if (isAttempting && !isReconnecting) {
      // First-time connect, no cycle yet.
      title = `Connecting to ${serverName ?? 'server'}…`;
      dotPulse = true;
    } else if (isReconnecting) {
      // Auto-reconnect cycle running — same copy whether we're in
      // 'connecting' (mid-attempt) or 'disconnected' (backoff wait).
      title = `Reconnecting to ${serverName ?? 'server'}…`;
      dotPulse = true;
    } else {
      // Manual mode — cycle inactive, user has to click Reconnect.
      title = `Disconnected from ${serverName ?? 'server'}`;
      dotPulse = false;
    }
    return (
      <main class="chat-area chat-area-engine">
        <EngineHeader
          title={isReconnecting ? 'Reconnecting' : (isAttempting ? 'Connecting' : 'Disconnected')}
          serverName={serverName}
          onBack={onBack}
        />
        <div class="chat-engine-splash">
          <StatusDot status={dotPulse ? 'accent' : 'offline'} size={10} pulse={dotPulse} class="chat-engine-dot" />
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
              <Button
                variant="primary"
                class="chat-engine-reconnect"
                onClick={onReconnect}
                disabled={isAttempting}
              >
                Reconnect
              </Button>
            )}
            {/* Cancel: only meaningful while the auto-reconnect cycle
                is running — clicking it stops the cycle and the user
                falls through to the manual-mode splash. */}
            {isReconnecting && onCancelReconnect && (
              <Button
                variant="secondary"
                class="chat-engine-cancel"
                onClick={onCancelReconnect}
              >
                Cancel
              </Button>
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
        <BouncerUpstreamBanner
          serverInfo={serverInfo}
          serverName={serverName}
          onConnect={onBouncerConnect}
          onTrustCert={onTrustBouncerCert}
          onRejectCert={onRejectBouncerCert}
        />
        {welcome ?? <EmptyState class="chat-area-empty-state">Select a channel from the sidebar, or join one to start chatting.</EmptyState>}
      </main>
    );
  }

  const display = channel.name.replace(/^[#&]/, '');
  const prefix = channel.name.startsWith('#') || channel.name.startsWith('&') ? '#' : '@';
  // A channel stays listed while its JOIN is pending (restore, a bouncer
  // still connecting): nothing typed there would reach it, so hold input.
  const joining = prefix === '#' && !channel.joined;
  const offline = engineState !== 'connected';
  const joinError = !channel.joined && channel.joinStatus?.state === 'failed' ? channel.joinStatus.error : null;
  // Typing is fine while reconnecting: a message waits ("Sending…") and goes
  // out once the channel is rejoined (ChatService.send).

  // Topics often carry mIRC colour codes; show the plain text.
  const topic = channel.topic ? stripIrcFormatting(channel.topic).trim() : '';
  return (
    <main class="chat-area" ref={mainRef} {...(canUpload ? drop.handlers : {})}>
      {/* The conversation stays mounted (its place kept) under the search page. */}
      <div class="chat-area-conv" inert={searchOpen || undefined} aria-hidden={searchOpen || undefined}>
        {canUpload && drop.dragging && (
          <div class="chat-drop-overlay" data-testid="chat-drop-overlay" aria-hidden="true">
            <span class="chat-drop-overlay-label">Drop files to upload to {prefix}{display}</span>
          </div>
        )}
        <div class="chat-header">
          <div class="chat-header-left">
            <PaneBackButton onBack={onBack} />
            <span class="chat-channel-hash">{prefix}</span>
            <span class="chat-channel-label">{display}</span>
            {/* A phone's header is the name: the topic (in channel settings)
                and the registration badge (an unregistered channel keeps its
                "Register it" strip) stay on wider screens. */}
            {narrow ? null : registration && prefix === '#' && registration.atRisk ? (
              <Button
                variant="ghost"
                size={narrow ? 'lg' : 'sm'}
                class="chat-reg-badge chat-reg-chip"
                onClick={onOpenRegistration}
                disabled={!onOpenRegistration}
                title="Not registered: you lose operator once everyone leaves. Register it so it stays yours."
                icon={<ShieldOff aria-hidden="true" />}
              >
                Unregistered
              </Button>
            ) : registration && prefix === '#' && (
              <Button
                variant="ghost"
                size={narrow ? 'lg' : 'sm'}
                tone={registration.registered ? 'success' : undefined}
                class={`chat-reg-badge${registration.registered ? ' chat-reg-badge-on' : ''}`}
                onClick={onOpenRegistration}
                disabled={!onOpenRegistration}
                title={registration.registered ? `Registered${registration.founder ? ` to ${registration.founder}` : ''}` : 'Not registered'}
                aria-label={registration.registered ? `Registered${registration.founder ? ` to ${registration.founder}` : ''}` : 'Not registered'}
                icon={registration.registered ? <ShieldCheck aria-hidden="true" /> : <ShieldOff aria-hidden="true" />}
              />
            )}
            {topic && !narrow && (
              <span
                class="chat-channel-topic"
                title={topic}
                aria-label={`Topic: ${topic}`}
              >
                {topic}
              </span>
            )}
          </div>
          <div class="chat-header-right">
            {onOpenSearch && (
              <Button
                variant="ghost"
                size={narrow ? 'lg' : 'sm'}
                class="chat-search-btn"
                buttonRef={searchBtnRef}
                pressed={searchOpen}
                onClick={onOpenSearch}
                title={`Search this conversation (${isMac() ? '⌘' : 'Ctrl+'}F)`}
                aria-label={narrow ? `Search in ${prefix}${display}` : 'Search this conversation'}
                icon={<Search aria-hidden="true" />}
              />
            )}
            {narrow ? (
              <HeaderMore
                memberCount={onShowMembers ? channel.members.length : undefined}
                onMembers={onShowMembers}
                onSettings={onOpenChannelSettings}
              />
            ) : null}
            {!narrow && onShowMembers && (
              <Button
                variant="ghost"
                size={narrow ? 'lg' : 'sm'}
                class="chat-pane-members"
                onClick={onShowMembers}
                pressed={membersShown}
                title="Members"
                aria-label={`Members (${channel.members.length})`}
                icon={<Users aria-hidden="true" />}
              />
            )}
            {!narrow && !onShowMembers && onToggleMembers && (
              <Button
                variant="ghost"
                size="sm"
                class="chat-members-toggle"
                pressed={!!membersShown}
                onClick={onToggleMembers}
                title={membersShown ? 'Hide members' : 'Show members'}
                aria-label={`${membersShown ? 'Hide' : 'Show'} members (${channel.members.length})`}
                icon={<Users aria-hidden="true" />}
              />
            )}
            {!narrow && onOpenChannelSettings && (
              <Button
                variant="ghost"
                size="sm"
                class="chat-channel-gear"
                onClick={onOpenChannelSettings}
                title="Channel settings"
                aria-label="Channel settings"
                icon={<Settings aria-hidden="true" />}
              />
            )}
          </div>
        </div>
        {callStrip}

        {offline && (slowReconnect || needsUser) && (
          <ConnectionStrip
            engineState={engineState}
            reconnectActive={reconnectActive}
            connectionError={connectionError}
            onReconnect={onReconnect}
            onCancelReconnect={onCancelReconnect}
          />
        )}

        {!offline && joining && (
          <div class="chat-connection-strip chat-join-strip" role="status" data-state={joinError ? 'failed' : 'joining'}>
            <StatusDot status={joinError ? 'offline' : 'accent'} size={8} pulse={!joinError} class="chat-engine-dot" />
            <span class="chat-connection-strip-label">
              {joinError ? `Couldn't join ${prefix}${display}` : `Joining ${prefix}${display}…`}
            </span>
            {joinError && <span class="chat-connection-strip-reason">{joinError}</span>}
            {joinError && onRejoin && (
              <span class="chat-connection-strip-actions">
                <Button variant="secondary" size="sm" class="chat-connection-strip-btn" onClick={() => onRejoin(channel.name)}>Try again</Button>
              </span>
            )}
          </div>
        )}

        {registerPrompt && prefix === '#' && (
          <div class="chat-connection-strip chat-reg-strip" role="status">
            <ShieldAlert aria-hidden="true" class="chat-reg-strip-icon" />
            <span class="chat-reg-strip-text">
              <strong>{prefix}{display}</strong> isn't registered. When everyone leaves, whoever joins first gets operator.
              Register it so it stays yours.
            </span>
            <span class="chat-connection-strip-actions">
              <Button variant="primary" size="sm" class="chat-connection-strip-btn" onClick={registerPrompt.onRegister}>Register {prefix}{display}</Button>
              <Button variant="ghost" size="sm" class="chat-connection-strip-btn" onClick={registerPrompt.onDismiss}>Not now</Button>
            </span>
          </div>
        )}

        <PendingConfirmationBanner
          serverId={activeServerId ?? null}
          serverName={serverName}
          onOpenSettings={onOpenServerSettings}
        />

        <BouncerUpstreamBanner
          serverInfo={serverInfo}
          serverName={serverName}
          onConnect={onBouncerConnect}
          onTrustCert={onTrustBouncerCert}
          onRejectCert={onRejectBouncerCert}
        />

        <MessageList
          messages={msgSignal}
          members={channel.members}
          myNick={myNick}
          scrollRef={scrollRef}
          nickActions={rowNickActions}
          channelName={channel.name}
          avatarFor={avatarFor}
          onLoadOlder={onLoadOlder ? () => onLoadOlder(channel.name) : undefined}
          onViewport={onViewport}
          historySupported={!!onLoadOlder && !!serverInfo?.scrollbackAvailable}
          historyLoading={channel.history?.loading}
          historyExhausted={channel.history?.exhausted}
          historyError={channel.history?.error}
          beginningNote={channel.name.startsWith('~') ? undefined : prefix === '#'
            ? "Messages from before you joined aren't available on this server."
            : "Earlier messages in this conversation aren't available on this server."}
          jump={searchJump}
          search={searchMarks}
          toLatest={latestSeq}
          replyContext={replyContext}
          onOpenThread={onOpenThread}
          threadJump={threadJump}
        />

        {searchJump && (
          <div class="search-return">
            <div class="search-return-pills">
              {onBackToResults && (
                <Button variant="secondary" size={narrow ? 'sm' : 'md'} class="search-return-back" onClick={onBackToResults}
                  icon={<ArrowLeft aria-hidden="true" />}>
                  Back to results
                </Button>
              )}
              <Button variant="primary" size={narrow ? 'sm' : 'md'} class="search-return-latest"
                onClick={() => { setLatestSeq((n) => n + 1); onDismissSearchJump?.(); }}
                icon={<ArrowDown aria-hidden="true" />}>
                Jump to latest
              </Button>
            </div>
          </div>
        )}

        <UploadProgress
          uploads={channelUploads}
          onCancel={(id) => files?.cancel(id)}
          onDismiss={(id) => files?.dismiss(id)}
          onCancelAll={serverHost && uploadTarget ? () => files?.cancelAll(serverHost, uploadTarget) : undefined}
        />

        <TypingIndicator nicks={channel.typing} />

        <ChatInputBar
          state={state}
          bloc={bloc}
          placeholder={joining && !offline
            ? (joinError ? `Not in ${prefix}${display}` : `Joining ${prefix}${display}…`)
            : `Message ${prefix}${display}`}
          disabled={joining && !offline}
          bannerError={bannerError}
          onDismissBanner={onDismissBanner}
          myNick={myNick}
          onFiles={canUpload ? openSheet : undefined}
          replying={replyTarget ? { nick: replyTarget.from, text: excerptOf(replyTarget.text) } : null}
          onCancelReply={() => setReplyTarget(null)}
        />
        {sheetFiles && (
          <UploadSheet
            open
            files={sheetFiles}
            target={`${prefix}${display}`}
            limits={filesAvail?.limits ?? null}
            usage={usage}
            homeLabel={filesAvail?.home ? filesAvail.label : undefined}
            notice={sheetNotice}
            onSend={sendUploads}
            onCancel={closeSheet}
            onAdd={openSheet}
            onRemove={(f) => {
              setSheetNotice(undefined);
              setSheetFiles((fs) => {
                const next = (fs ?? []).filter((x) => x !== f);
                return next.length ? next : null;
              });
            }}
          />
        )}
      </div>
      {searchOpen && searchPage}
    </main>
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

// The connection is down (or coming back) while a conversation is open: a
// slim strip under the header, the conversation stays. Same states and
// actions as the splash.
// How long a reconnect runs before the strip says so.
export const STRIP_DELAY_MS = 3000;

/** True once `on` has held for `ms`; false again as soon as it doesn't. */
function useAfter(on: boolean, ms: number): boolean {
  const [held, setHeld] = useState(false);
  useEffect(() => {
    if (!on) { setHeld(false); return; }
    const t = setTimeout(() => setHeld(true), ms);
    return () => clearTimeout(t);
  }, [on, ms]);
  return on && held;
}

interface ConnectionStripProps {
  engineState: EngineState;
  reconnectActive?: boolean;
  connectionError?: string | null;
  onReconnect?: () => void;
  onCancelReconnect?: () => void;
}

function ConnectionStrip({ engineState, reconnectActive, connectionError, onReconnect, onCancelReconnect }: ConnectionStripProps) {
  const attempting = engineState === 'connecting';
  const label = reconnectActive ? 'Reconnecting…' : attempting ? 'Connecting…' : 'Disconnected';
  return (
    <div class="chat-connection-strip" role="status">
      <StatusDot status={reconnectActive || attempting ? 'accent' : 'offline'} size={8} pulse={reconnectActive || attempting} class="chat-engine-dot" />
      <span class="chat-connection-strip-label">{label}</span>
      {engineState === 'disconnected' && connectionError && (
        <span class="chat-connection-strip-reason">{connectionError}</span>
      )}
      <span class="chat-connection-strip-actions">
        {(engineState === 'disconnected' || reconnectActive) && onReconnect && (
          <Button variant="secondary" size="sm" class="chat-connection-strip-btn" onClick={onReconnect} disabled={attempting}>
            Reconnect
          </Button>
        )}
        {reconnectActive && onCancelReconnect && (
          <Button variant="secondary" size="sm" class="chat-connection-strip-btn" onClick={onCancelReconnect}>Cancel</Button>
        )}
      </span>
    </div>
  );
}

// Shared header for the connecting / disconnected splashes. Keeps the chat
// shell's visual rhythm (border-bottom, padding) consistent with the active-
// channel header.
interface EngineHeaderProps {
  title: string;
  serverName: string | undefined;
  onBack?: () => void;
}

function EngineHeader({ title, serverName, onBack }: EngineHeaderProps) {
  return (
    <div class="chat-header">
      <div class="chat-header-left">
        <PaneBackButton onBack={onBack} />
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
        <Button variant="secondary" size="sm" class="chat-pending-confirm-link" onClick={onOpenSettings}>
          Open settings
        </Button>
      )}
    </div>
  );
}


interface BouncerUpstreamBannerProps {
  serverInfo?: ServerInfo;
  serverName?: string;
  onConnect?: () => void;
  onTrustCert?: () => void;
  onRejectCert?: () => void;
}

// Slim strip under the chat header for bouncer (ZNC) connections whose
// bouncer is NOT connected to the real network. The engine's link to the
// bouncer is up (so the rest of the UI says "connected"), but nothing the
// user sends reaches the network until the bouncer reconnects upstream.
//   disconnected → "Your bouncer isn't connected to X." + [Connect]
//   connecting   → spinner + "Connecting to X…", no action
//   certificate  → the bouncer won't accept X's TLS certificate until told
//                  to: [Trust certificate] [Don't trust]. Takes precedence,
//                  since connecting can't succeed until it's answered.
// Renders nothing for direct connections, an unknown state, or connected.
export function BouncerUpstreamBanner({ serverInfo, serverName, onConnect, onTrustCert, onRejectCert }: BouncerUpstreamBannerProps) {
  const upstream = serverInfo?.bouncerUpstream;
  const cert = serverInfo?.bouncerCert;
  if (serverInfo && cert) {
    const network = serverInfo.network || serverName || 'the network';
    return (
      <div class="chat-bouncer-upstream-banner" data-state="certificate" role="alert">
        <ShieldAlert size={14} class="chat-bouncer-upstream-icon" aria-hidden="true" />
        <span class="chat-bouncer-upstream-text">
          Your bouncer doesn't trust {network}'s certificate{cert.reason ? ` (${cert.reason})` : ''}.
          {' '}Trust only if you expected this.
          <span class="chat-bouncer-upstream-fingerprint" title={`SHA-256 ${cert.fingerprint}`}>
            SHA-256 {cert.fingerprint}
          </span>
        </span>
        {onRejectCert && (
          <Button variant="ghost" size="sm" class="chat-bouncer-upstream-action" onClick={onRejectCert}>
            Don't trust
          </Button>
        )}
        {onTrustCert && (
          <Button variant="secondary" size="sm" class="chat-bouncer-upstream-action" onClick={onTrustCert}>
            Trust certificate
          </Button>
        )}
      </div>
    );
  }
  if (!serverInfo?.bouncer || (upstream !== 'disconnected' && upstream !== 'connecting')) return null;
  const network = serverInfo.network || serverName || 'the network';
  if (upstream === 'connecting') {
    return (
      <div class="chat-bouncer-upstream-banner" data-state="connecting" role="status">
        <PlugZap size={14} class="chat-bouncer-upstream-icon" aria-hidden="true" />
        <span class="chat-bouncer-upstream-text">
          Your bouncer is connecting to {network}…
        </span>
        <BarLoader class="chat-bouncer-upstream-bar" label={`Connecting to ${network}`} />
      </div>
    );
  }
  return (
    <div class="chat-bouncer-upstream-banner" data-state="disconnected" role="status">
      <Unplug size={14} class="chat-bouncer-upstream-icon" aria-hidden="true" />
      <span class="chat-bouncer-upstream-text">
        Your bouncer isn't connected to {network}.
      </span>
      {onConnect && (
        <Button variant="secondary" size="sm" class="chat-bouncer-upstream-action" onClick={onConnect}>
          Connect
        </Button>
      )}
    </div>
  );
}
