import { NetworkAccountBar } from '../NetworkSignIn/NetworkAccountBar';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { JSX } from 'preact';
import type { ChatService, ChatState } from '../../modules/chat';
import { banMask, OP } from '../../modules/chat';
import type { EngineState } from '../../modules/engine';
import { Button, Input, Modal } from '@boson/shared';
import { ServerRail, type ServerRailTile } from './ServerRail';
import { ChannelSidebar } from './ChannelSidebar';
import { VoiceSection } from './VoiceSection';
import { ChannelVoiceAdd, ChannelVoiceRooms } from './VoiceRooms';
import { VoiceBar } from './VoiceBar';
import { ChatArea } from './ChatArea';
import { SearchPage } from './SearchPage';
import { signal } from '@preact/signals';
import type { ChatMessage } from '../../modules/chat';
import { conversationSearch, historySource, revealResult } from '../../modules/search/search-session';
import { UserPanel } from './UserPanel';
import { ThreadPanel } from './ThreadPanel';
import { threadIndexFor } from '../../modules/chat/threads';
import { pendingThread, THREAD_INTENT_TTL_MS } from '../../modules/chat/thread-nav';
import { ServerWelcome, welcomeChannels } from './ServerWelcome';
import { ChannelSettings, type ChannelSettingsTab } from './ChannelSettings';
import { useChannelCreation, useChannelPolicy, type ChanServState } from '../../modules/chanserv';
import { ResizeHandle } from './ResizeHandle';
import { getPanelWidth, setPanelWidth, PANEL_BOUNDS } from '../../modules/ui/panel-sizes';
import type { ChannelOpActions, NickProfiles } from './nick-actions';
import { useAvatarFor } from '../../shared/Avatar/use-avatar-for';
import { ChatLayoutBloc, type ChatLayoutState } from './ChatLayoutBloc';
import { messageActionsFor } from './message-actions';
import { isNarrow, useMid, useNarrow, useNoTitleBar } from '../../shared/narrow';
import { MobileCallScreen, MobileMiniBar } from './MobileCall';
import { closeCall, isPrivateCall } from './call-shared';
import { PreJoinPeople, VoiceJoinSheet, VoicePreJoin } from './PreJoin';
import { CallStage } from './CallStage';
import { CallPanel, type CallChat } from './CallPanel';
import { InCallStrip } from './InCallStrip';
import { ScreenPicker } from './ScreenPicker';
import { setVoiceUi, useVoiceUi } from './VoiceRooms';
import { getVideoController, useVideo } from '../../modules/video';
import { useVoice } from '../../modules/voice';
import { useFriends } from '../../modules/friends';
import { getFriendsUi, setFriendsUi, useFriendsUi, type PhonePage as PhonePageId } from '../Friends/friends-ui';
import { SETTLE_MS, useSwipeNav } from './useSwipeNav';
import { setVoiceJoiner } from '../Notifications/navigate';
import { setConversationShown } from '../../modules/ui/notifier';
import { getMemoStore } from '../../modules/memos';
import { FriendsView } from '../Friends/FriendsView';
import { PhonePage } from '../Friends/FriendsNav';
import { getNotificationFeed } from '../../modules/notifications/feed';
import { CallsView, MyRailTile, MySidebar, RailDivider, type MyDm, type Presence } from '../Friends/MySpace';
import { useOnline } from '../../shared/online';
import { RailBell } from '../Notifications/NotificationsBell';
import './ChatLayout.css';
import './NetworkPanes.css';

interface Props {
  chat: ChatService;
  serverName: string;
  // The active server's IRC hostname: voice channels are discovered per
  // server (absent → no voice section).
  serverHost?: string;
  // CDN URL of the active server's wide banner, when the owner set one.
  // Rendered as the ChannelSidebar header strip; absent → plain text header.
  bannerUrl?: string;
  // The active network's logo (network themes): the sidebar header.
  logoUrl?: string;
  // "Use this network's theme" toggled from a rail tile's menu.
  onToggleNetworkTheme?: (serverId: string, on: boolean) => void;
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
  // Mark everything on a server read (its tile's menu).
  onMarkServerRead?: (serverId: string) => void;
  // Bouncer upstream controls for a rail tile's server (right-click menu).
  // The active server's in-chat strip uses `chat.bouncerConnect()` directly.
  onBouncerConnect?: (serverId: string) => void;
  onBouncerDisconnect?: (serverId: string) => void;
  // The rail was dragged into a new order (server ids, top to bottom).
  onReorderServers?: (serverIds: string[]) => void;
  // The user's channel-list order for the active server (channel keys),
  // and the handlers that save / reset it. Without onReorderChannels the
  // channel list doesn't reorder.
  channelOrder?: readonly string[];
  // The default order under it: the saved channels, in order.
  defaultChannelOrder?: readonly string[];
  onReorderChannels?: (names: string[]) => void;
  onResetChannelOrder?: () => void;
  // MY's direct messages (every connected server's), and opening one:
  // its server becomes the active one, with the conversation open.
  myDms?: readonly MyDm[];
  onOpenDm?: (serverId: string, name: string) => void;
  // The active server's directory listing: its description (under its
  // name, and on its welcome) and channels (suggested on the welcome).
  serverDescription?: string;
  serverChannels?: readonly string[];
}

// Phones: the launch has opened onto the last conversation (once per run).
let launchShown = false;

// Below this window width the desktop member list starts hidden.
export const MEMBERS_AUTO_WIDTH = 1200;
const MEMBERS_AUTO_QUERY = `(min-width: ${MEMBERS_AUTO_WIDTH}px)`;

// Whether the desktop member list is shown: by default when the window is
// wide enough; the user's toggle holds until the window crosses the width.
function useMembersOpen(): { open: boolean; toggle: () => void } {
  const wide = (): boolean => typeof window === 'undefined' || typeof window.matchMedia !== 'function'
    || window.matchMedia(MEMBERS_AUTO_QUERY).matches;
  const [open, setOpen] = useState(wide);
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const mq = window.matchMedia(MEMBERS_AUTO_QUERY);
    const onChange = (): void => setOpen(mq.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);
  return { open, toggle: () => setOpen((v) => !v) };
}

// The phone's main area (the conversation, Friends, Calls): it stays on top
// of the channel list and the members while swiping between them.
function isMainPage(p: PhonePageId | null | undefined): boolean {
  return p !== undefined && p !== null && p !== 'members';
}

export function ChatLayout({
  chat, serverName, serverHost, bannerUrl, logoUrl, onToggleNetworkTheme, myNick, servers, activeServerId, onSelectServer, onBrowseServers,
  engineState = 'connected', onReconnect, onCancelReconnect, reconnectActive = false,
  connectionError, onOpenServerSettings, onLeaveServer, onMarkServerRead, onBouncerConnect, onBouncerDisconnect,
  onReorderServers, channelOrder, defaultChannelOrder, onReorderChannels, onResetChannelOrder, myDms, onOpenDm,
  serverDescription, serverChannels,
}: Props) {
  // Two sources of truth, both consumed via subscribe():
  //   1. ChatService owns the 4-column UI state (channels, members, log).
  //   2. ChatLayoutBloc owns transient feedback (error banner + help modal).
  const [subscribed, setState] = useState<ChatState>(chat.getState());
  // Another server's chat: its state at once, not the last server's for a
  // render (until the subscription below catches up).
  const [stateOf, setStateOf] = useState(chat);
  if (stateOf !== chat) { setStateOf(chat); setState(chat.getState()); }
  const state = stateOf === chat ? subscribed : chat.getState();
  const layoutBloc = useMemo(() => new ChatLayoutBloc({ chat }), [chat]);
  const [layoutState, setLayoutState] = useState<ChatLayoutState>(layoutBloc.getState());

  useEffect(() => chat.subscribe(setState), [chat]);
  useEffect(() => layoutBloc.subscribe(setLayoutState), [layoutBloc]);
  // dispose tears down the chat.onFeedback subscription and clears any
  // pending auto-dismiss timer the bloc may have scheduled.
  useEffect(() => () => layoutBloc.dispose(), [layoutBloc]);

  const active = state.channels.find((c) => c.name === state.activeChannel) ?? null;
  const { bannerError, helpCommands } = layoutState;
  // Originals of replies in the open conversation that aren't loaded
  // (hand-rolled test fakes may not have it).
  const replyChannel = active?.name ?? null;
  const replyContext = useMemo(() => (replyChannel && typeof chat.replyContext === 'function' ? {
    get: (msgid: string) => chat.replyContext(replyChannel, msgid),
    request: (msgids: readonly string[]) => chat.requestReplyContext(replyChannel, msgids),
    version: chat.replyContextVersion,
  } : null), [chat, replyChannel]);

  // Kick (and Kick+Ban) collect an optional reason via a small modal before
  // firing. `ban` is whether to also ban (the "Kick + Ban" menu item).
  const [kickTarget, setKickTarget] = useState<{ nick: string; ban: boolean } | null>(null);
  const [kickReason, setKickReason] = useState('');
  // Channel Settings modal open state (gear on the channel header).
  const [channelSettingsOpen, setChannelSettingsOpen] = useState(false);
  const [channelSettingsTab, setChannelSettingsTab] = useState<ChannelSettingsTab>('channel');

  // Resizable side panels — initial width from the persisted store (localStorage,
  // which survives restarts + reinstalls), live-updated while dragging.
  const [channelsW, setChannelsW] = useState(() => getPanelWidth('channels'));
  const [membersW, setMembersW] = useState(() => getPanelWidth('members'));
  const [threadW, setThreadW] = useState(() => getPanelWidth('thread'));

  const isChannel = !!active && (active.name.startsWith('#') || active.name.startsWith('&'));
  // Desktop: the member list beside the conversation. Hidden by default in
  // a window under MEMBERS_AUTO_WIDTH (two side columns would squeeze the
  // conversation); the header's members button shows / hides it.
  const membersOpen = useMembersOpen();
  // In no channel (or conversation) of this server yet: the chat area
  // welcomes you to it instead of an empty room. Setting joinRequest opens
  // the sidebar's channel browser once: the sidebar clears it when it has
  // (it used to be a counter that stayed above zero, so every remount of
  // the sidebar — back from MY / Calls — opened the browser again).
  const hasConversations = state.channels.some((c) => !c.name.startsWith('~'));
  const [joinRequest, setJoinRequest] = useState(false);

  // Phones (and narrow windows) show one screen at a time, like the
  // desktop's columns in turn: the rail with the channel list, or a page
  // full screen with a back arrow (the conversation, its members, Friends,
  // Calls). friends-ui's `phone` is the page.
  const narrow = useNarrow();
  // The phone layout without the top bar: the bell joins the rail.
  const noTitleBar = useNoTitleBar();
  // Tablet portrait / narrow windows: the member list (or the call panel)
  // opens over the chat on demand instead of taking a fixed column.
  const mid = useMid();
  const [midPanel, setMidPanel] = useState(false);
  useEffect(() => {
    if (!mid) return;
    // Bound for as long as the layout is mid (not per opening), so an Escape
    // right after the panel opens isn't missed. Closed already: a no-op.
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') setMidPanel(false); };
    // Capture: the chat's own key handling (focus, Escape to clear) stops
    // the event before it would bubble here.
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [mid]);
  const phoneRef = useRef<HTMLDivElement>(null);
  // A conversation that becomes active on this server — picked, joined, or
  // opened from elsewhere — is what the user wants to see (switching
  // servers shows that server's channels). A launch opens onto the last
  // conversation.
  const activeName = state.activeChannel;
  if (narrow && !launchShown) {
    launchShown = true;
    if (activeName && !getFriendsUi().phone && !getFriendsUi().my) setFriendsUi({ phone: 'chat' });
  }
  const activeKey = `${activeServerId ?? ''}\0${activeName ?? ''}`;
  const [lastActive, setLastActive] = useState({ key: activeKey, server: activeServerId, name: activeName });
  if (activeKey !== lastActive.key) {
    const sameServer = lastActive.server === activeServerId;
    const prev = lastActive.name;
    setLastActive({ key: activeKey, server: activeServerId, name: activeName });
    if (activeName && sameServer) {
      if (narrow && getFriendsUi().phone !== 'chat') setFriendsUi({ phone: 'chat' });
    }
    if (activeName && prev && sameServer) {
      // MY shows direct messages: a channel opened from elsewhere (a
      // notification, the inbox) leaves it; a conversation shows in it.
      if (getFriendsUi().my) {
        if (activeName.startsWith('#') || activeName.startsWith('&')) setFriendsUi({ my: false });
        else setFriendsUi({ myView: 'chat' });
      }
    }
  }

  // ChanServ (channel registration) for this connection. `typeof` guard:
  // hand-rolled test fakes have no chanserv().
  const csCtl = typeof chat.chanserv === 'function' ? chat.chanserv() : null;
  const [csState, setCsState] = useState<ChanServState | null>(() => csCtl?.getState() ?? null);
  useEffect(() => (csCtl ? csCtl.subscribe(setCsState) : setCsState(null)), [csCtl]);
  const channelPolicy = useChannelPolicy(serverHost);
  // Admins-only channel creation (auth /v1/config channel_creation).
  const channelCreation = useChannelCreation(serverHost, { oper: state.myOper });
  const myAccount = typeof chat.selfIdentity === 'function' ? chat.selfIdentity().account : undefined;
  const activeJoined = !!active?.joined;
  useEffect(() => {
    if (csCtl && isChannel && active && activeJoined) csCtl.ensureInfo(active.name);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [csCtl, isChannel, active?.name, activeJoined, csState?.dialect, csState?.present]);
  const regInfo = csCtl && active && isChannel && csState?.present !== false ? csCtl.channel(active.name).info : undefined;
  // An operator of a channel that isn't registered loses it when everyone
  // leaves (whoever re-creates it gets operator): say so, and offer to
  // register it — when this network's ChanServ can.
  const canRegisterHere = !!csState?.caps?.register;
  const regAtRisk = !!regInfo && !regInfo.registered && !regInfo.closed && canRegisterHere;
  const registrationBadge = regInfo && !regInfo.closed ? { registered: regInfo.registered, founder: regInfo.founder } : null;
  const [regPromptDismissed, setRegPromptDismissed] = useState<ReadonlySet<string>>(() => new Set());

  const supportsOwnerAdmin = /[qa]/.test(state.serverInfo.prefix?.modes ?? 'qa');
  // Our rank in the active channel. `typeof` guard keeps hand-rolled test fakes
  // (no myRank method) working — they read as rank 0.
  const myRankHere = active && typeof chat.myRank === 'function' ? chat.myRank(active.name) : 0;

  // Action callbacks bound to the right-click nick context menu. Wired
  // to ChatService so both the member panel and the message-row nicks
  // share the same behaviour. `ops` is present only inside a channel and
  // carries the channel-operator actions, gated in the menu by our rank.
  // Reactions need message-tags; Delete, the server's draft/message-redaction.
  const reactCaps = (state.serverInfo.enabledCaps ?? []).includes('message-tags');
  const redactCap = (state.serverInfo.enabledCaps ?? []).includes('draft/message-redaction');
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
    // WHOIS for the profile a click on a nick opens (absent on test fakes).
    const profiles: NickProfiles | undefined = typeof chat.requestWhois === 'function' ? {
      info: (n: string) => chat.whois.value.get(n.toLowerCase()),
      request: (n: string) => chat.requestWhois(n),
      seen: (n: string) => chat.seen?.get(n),
    } : undefined;
    const message = active ? messageActionsFor(chat, active.name, {
      reactions: reactCaps, redaction: redactCap, myNick: state.myNick, myAccount, myRank: myRankHere, isChannel,
    }) : undefined;
    return { onSendMessage: (nick: string) => chat.openDM(nick), ops, profiles, message };
  }, [chat, active, isChannel, supportsOwnerAdmin, myRankHere, reactCaps, redactCap, state.myNick, myAccount]);

  // Resolves a nick → profile-image URL for Boson members on this server
  // (own avatar + presence matches), shared by the chat stream + member list.
  const avatarFor = useAvatarFor(activeServerId ?? null);

  // The full-page search (header Search, Ctrl/Cmd+F): over the conversation
  // (on desktop the member list makes way for its Context panel). A result
  // opened goes to the conversation, with "Back to results" to return.
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchFocus, setSearchFocus] = useState(0);
  const [searchRestoring, setSearchRestoring] = useState(false);
  const [searchJump, setSearchJump] = useState<{ id: string; seq: number; query: string } | null>(null);
  const searchJumpSeq = useRef(0);
  useEffect(() => { setSearchOpen(false); setSearchJump(null); }, [activeKey]);
  const activeConvName = active?.name ?? null;
  const searchSession = activeConvName ? conversationSearch(activeServerId ?? serverHost ?? '', activeConvName) : null;
  const searchHistory = useMemo(
    () => (activeConvName && typeof chat.fetchHistory === 'function' ? historySource(chat, activeConvName) : null),
    [chat, activeConvName],
  );
  const liveMessages = active && typeof chat.messagesSignal === 'function' ? chat.messagesSignal(active.name) : null;
  const searchMessages = useMemo(() => liveMessages ?? signal<ChatMessage[]>(active?.messages ?? []), [liveMessages, active?.messages]);
  const openSearch = (): void => {
    setSearchRestoring(false);
    setSearchOpen(true);
    setSearchFocus((n) => n + 1);
    setMidPanel(false);
  };
  const openSearchResult = async (m: ChatMessage): Promise<void> => {
    if (!activeConvName || !searchSession) return;
    const id = typeof chat.revealHistory === 'function'
      ? await revealResult(chat, activeConvName, searchSession.pager.getState().lines, m)
      : m.id;
    if (!id) throw new Error('it is no longer available');
    setSearchOpen(false);
    searchJumpSeq.current += 1;
    setSearchJump({ id, seq: searchJumpSeq.current, query: searchSession.ui.query });
  };
  const searchPage = searchOpen && active && searchSession ? (
    <SearchPage
      key={activeKey}
      conversation={active.name}
      session={searchSession}
      messages={searchMessages}
      members={active.members}
      history={searchHistory}
      avatarFor={avatarFor}
      narrow={narrow}
      wide={!narrow && !mid}
      focusSeq={searchFocus}
      restoring={searchRestoring}
      onClose={() => { setSearchOpen(false); setSearchJump(null); }}
      onOpenResult={openSearchResult}
    />
  ) : null;
  // A thread (ThreadPanel): open in this conversation only. On a desktop
  // the right-hand column (in place of the member list), at mid width its
  // overlay, on a phone a full-height sheet.
  const [thread, setThread] = useState<{ key: string; rootId: string } | null>(null);
  const threadRoot = thread && thread.key === activeKey ? thread.rootId : null;
  const [threadJump, setThreadJump] = useState<{ id: string; seq: number } | null>(null);
  const openThread = (rootId: string): void => {
    setThread({ key: activeKey, rootId });
    setSearchOpen(false);
    if (mid) setMidPanel(true);
  };
  const closeThread = (): void => {
    setThread(null);
    if (mid) setMidPanel(false);
  };
  // The mid-width overlay closed (a click beside it): the thread with it.
  useEffect(() => { if (mid && !midPanel) setThread(null); }, [mid, midPanel]);
  const openThreadRef = useRef(openThread);
  openThreadRef.current = openThread;
  // A notification of a reply (thread-nav.ts): once its conversation is the
  // active one and the message is loaded, open the thread it's in.
  const threadIntent = pendingThread.value;
  useEffect(() => {
    if (!threadIntent || !active || !activeServerId) return undefined;
    if (threadIntent.serverId !== activeServerId || threadIntent.channel.toLowerCase() !== active.name.toLowerCase()) return undefined;
    const sig = searchMessages;
    const tryOpen = (): void => {
      if (pendingThread.peek() !== threadIntent) return;
      if (Date.now() - threadIntent.at > THREAD_INTENT_TTL_MS) { pendingThread.value = null; return; }
      const ix = threadIndexFor(sig);
      ix.sync(sig.peek());
      const m = (threadIntent.messageId ? ix.get(threadIntent.messageId) : undefined)
        ?? (threadIntent.msgid ? ix.byMsgidOf(threadIntent.msgid) : undefined);
      if (!m) return;
      pendingThread.value = null;
      // Only a reply in a thread (a line that merely has replies by now
      // just shows in the conversation).
      const root = ix.rootOf(m.id);
      if (root !== m.id) openThreadRef.current(root);
    };
    return sig.subscribe(tryOpen);
  }, [threadIntent, active?.name, activeServerId, searchMessages]);

  // In a call: its stage (desktop) or call screen (phone) takes the
  // chat's place while you're on it.
  const { video, snap: videoSnap } = useVideo();
  const { snap: voiceSnap } = useVoice();
  // A voice channel clicked in the sidebar and not joined: its pre-join
  // view (the desktop's main column; a phone shows a join sheet).
  const { view: voiceView } = useVoiceUi();
  const call = voiceSnap.call;
  // Another server: its voice channel's view doesn't follow, unless it's
  // the voice channel Join (Calls) switched servers for.
  const pendingJoin = useRef<{ host: string; roomId: string; serverName: string } | null>(null);
  useEffect(() => {
    const join = pendingJoin.current;
    pendingJoin.current = null;
    setVoiceUi({ view: join && join.host === serverHost ? join : null });
    if (!isNarrow()) getVideoController()?.setOpen(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeServerId]);
  // Desktop: the call's stage while you're on its voice channel (or the
  // call was opened from the voice panel, the title bar or the strip).
  const inCall = call.status === 'connected' && !!call.host;
  const onCallView = !!voiceView && voiceView.host === call.host && voiceView.roomId === call.room;
  const stageOpen = !narrow && inCall && (onCallView || videoSnap.open);
  // A phone: the call screen in place of the chat while it's open (else a
  // bar at the bottom of every screen).
  const phoneCallOpen = narrow && inCall && (onCallView || videoSnap.open);
  // Video is received only while a call view shows it.
  useEffect(() => {
    const want = stageOpen || phoneCallOpen;
    if (video && video.getSnapshot().open !== want) video.setOpen(want);
  }, [video, stageOpen, phoneCallOpen]);
  // CHAT on the call's panel: the text channel the voice channel is under.
  const callRoom = inCall ? voiceSnap.servers[call.host]?.rooms?.find((r) => r.id === call.room) : undefined;
  const chatChannel = callRoom?.parent ? state.channels.find((c) => c.name.toLowerCase() === callRoom.parent) : undefined;
  const callChat: CallChat | null = chatChannel
    ? { channel: chatChannel.name, messages: chatChannel.messages, onSend: (text) => chat.send(chatChannel.name, text) }
    : null;
  // Friends (signed in with an account). MY (your avatar, top of the rail)
  // holds Friends, Calls and your direct messages; on phones, for now, the
  // bottom bar's tabs. Person menus are for this server's people.
  const { snap: friendsSnap } = useFriends();
  const friendsUi = useFriendsUi();
  useEffect(() => { setFriendsUi({ host: serverHost ?? null }); }, [serverHost]);
  // The phone's page (null: the rail and channel list). A conversation's
  // page needs one open; its members, a channel.
  const phonePage = !narrow ? null
    : friendsUi.phone === 'chat' && !active ? null
      : friendsUi.phone === 'members' && !isChannel ? (active ? 'chat' : null)
        : friendsUi.phone;
  const inViewedRoom = !!voiceView && call.host === voiceView.host && call.room === voiceView.roomId && call.status !== 'idle' && call.status !== 'error';
  // A private 1:1 call (friends) has no join screen: you're in it from the
  // moment you answer, and once it ends its room is gone. Its view closes.
  const privateView = !!voiceView && isPrivateCall(voiceView.roomId);
  useEffect(() => { if (privateView && !inViewedRoom) setVoiceUi({ view: null }); }, [privateView, inViewedRoom]);
  const prejoinOpen = !!voiceView && !privateView && !inViewedRoom;
  const selfNick = state.myNick || myNick;
  // Your presence is the account's, not the open server's: online while any
  // server is connected (one failing doesn't make you offline elsewhere),
  // offline when none is or the device has no network.
  const online = useOnline();
  const anyConnected = servers && servers.length > 0
    ? servers.some((t) => t.engineState === 'connected')
    : engineState === 'connected';
  const presence: Presence = !online || !anyConnected ? 'offline' : friendsSnap.privacy.doNotDisturb ? 'dnd' : 'online';
  const myOpen = friendsUi.my;
  // MY's main column: a conversation only while a DM is the active one.
  const myView = friendsUi.myView === 'chat' && (!active || isChannel) ? 'friends' : friendsUi.myView;
  const activeDm = myOpen && myView === 'chat' && active && activeServerId ? { serverId: activeServerId, name: active.name } : null;
  const serverNameFor = (host: string): string | undefined =>
    host === serverHost ? serverName : servers?.find((t) => t.host === host)?.name;
  // Join on the Calls page: the voice channel's join view, on its server.
  const joinLive = (host: string, roomId: string, roomName: string): void => {
    const view = { host, roomId, serverName: serverNameFor(host) ?? roomName };
    setFriendsUi({ my: false, phone: null });
    if (host === serverHost || !onSelectServer) { setVoiceUi({ view }); return; }
    const tile = servers?.find((t) => t.host === host);
    if (!tile) { setVoiceUi({ view }); return; }
    pendingJoin.current = view;
    onSelectServer(tile.serverId);
  };
  // Whether the conversation is on screen: then a message in it gets no
  // toast, and its mentions / DM in the bell's list count as read.
  const chatShown = !!active && (narrow ? phonePage === 'chat' && !phoneCallOpen : !stageOpen && !prejoinOpen && (!myOpen || myView === 'chat'));
  const shownRef = useRef(chatShown);
  shownRef.current = chatShown;
  useEffect(() => {
    setConversationShown(() => shownRef.current);
    return () => setConversationShown(null);
  }, []);
  const activeConv = active?.name ?? null;
  useEffect(() => {
    if (!chatShown || !activeConv || !activeServerId) return;
    const store = getMemoStore();
    const mark = (): void => store.markConversationRead(activeServerId, activeConv);
    mark();
    return store.subscribe(mark);
  }, [chatShown, activeConv, activeServerId]);
  // A notification's Join (a call started) goes the same way.
  const joinRef = useRef(joinLive);
  joinRef.current = joinLive;
  useEffect(() => {
    setVoiceJoiner((room) => joinRef.current(room.host, room.roomId, room.name));
    return () => setVoiceJoiner(null);
  }, []);
  const calls = (layout: 'desktop' | 'phone') => <CallsView layout={layout} onJoin={joinLive} serverNameFor={serverNameFor} />;

  const rail = (
        <ServerRail
          servers={servers}
          activeServerId={myOpen ? null : activeServerId}
          activeServerName={serverName}
          onSelectServer={onSelectServer ? (id) => { setFriendsUi({ my: false, phone: null }); onSelectServer(id); } : undefined}
          top={(
            <>
              <MyRailTile nick={selfNick} avatarUrl={avatarFor(selfNick)} presence={presence} active={myOpen}
                unreadDms={(myDms ?? []).filter((d) => d.unread > 0).length}
                onClick={() => setFriendsUi({ my: true })} />
              {/* Phones have no top bar: its bell is here, under you. */}
              {noTitleBar && <RailBell />}
              <RailDivider />
            </>
          )}
          onBrowseServers={onBrowseServers}
          onOpenServerSettings={onOpenServerSettings}
          onLeaveServer={onLeaveServer}
          onMarkServerRead={onMarkServerRead}
          onBouncerConnect={onBouncerConnect}
          onBouncerDisconnect={onBouncerDisconnect}
          onReorderServers={onReorderServers}
          onToggleNetworkTheme={onToggleNetworkTheme}
        />
  );
  const mySidebar = (
    <MySidebar
        nick={selfNick}
        presence={presence}
        view={narrow ? null : myView}
        dms={myDms ?? []}
        activeDm={activeDm}
        showServer={(servers?.length ?? 0) > 1}
        width={narrow ? undefined : channelsW}
        onOpenDm={(d) => {
          setFriendsUi({ myView: 'chat', phone: 'chat' });
          if (onOpenDm) onOpenDm(d.serverId, d.name);
          else chat.setActive(d.name);
        }}
      />
  );
  const sidebar = (
        <ChannelSidebar
          serverName={serverName}
          // Phones: a compact header instead of the big banner.
          bannerUrl={narrow ? undefined : bannerUrl}
          logoUrl={logoUrl}
          channels={state.channels}
          activeChannel={state.activeChannel}
          onSelect={(name) => {
            // A text channel: leave the voice channel's view (the call
            // goes on; the strip and the title bar lead back).
            setVoiceUi({ view: null });
            if (!narrow) video?.setOpen(false);
            chat.setActive(name);
            setFriendsUi({ phone: 'chat' });
            // A channel we're not in: ask for it again (a no-op if joined).
            if (engineState === 'connected') chat.rejoin(name);
          }}
          onJoin={(name) => chat.join(name, { byUser: true })}
          onMarkRead={(name) => chat.markRead(name)}
          onPart={(name) => {
            // Undo (the toast): back in, as you were.
            const channel = /^[#&]/.test(name);
            chat.part(name);
            getNotificationFeed().toast({
              kind: 'undo', title: channel ? `Left ${name}` : `Closed ${name}`, where: serverName, body: '',
              nick: channel ? '' : name, serverId: activeServerId ?? undefined,
              undo: () => { if (channel) chat.join(name, { byUser: true }); else chat.openDM(name); },
            });
          }}
          onOpenAllDms={() => setFriendsUi({ my: true, phone: null })}
          channelOrder={channelOrder}
          defaultChannelOrder={defaultChannelOrder}
          serverId={activeServerId}
          onReorderChannels={onReorderChannels}
          onResetChannelOrder={onResetChannelOrder}
          channelDirectory={state.channelDirectory.entries}
          creation={channelCreation}
          serverDescription={serverDescription}
          openJoinRequest={joinRequest}
          onJoinRequestHandled={() => setJoinRequest(false)}
          onOpenSettings={
            onOpenServerSettings && activeServerId
              ? () => onOpenServerSettings(activeServerId)
              : undefined
          }
          serverInfo={state.serverInfo}
          engineState={engineState}
          width={channelsW}
          account={serverHost ? (
            <NetworkAccountBar host={serverHost} serverName={serverName} onSignedIn={onReconnect} />
          ) : undefined}
          voice={serverHost ? (
            <VoiceSection
              host={serverHost}
              serverName={serverName}
              engineState={engineState}
              avatarFor={avatarFor}
              channels={state.channels.map((c) => c.name)}
              nick={state.myNick || myNick}
            />
          ) : undefined}
          channelVoice={serverHost ? (name) => (
            <ChannelVoiceRooms host={serverHost} serverName={serverName} channel={name} avatarFor={avatarFor} />
          ) : undefined}
          channelAction={serverHost ? (name) => <ChannelVoiceAdd host={serverHost} channel={name} /> : undefined}
          // Phones: the minimized call bar under every screen instead.
          // The call screen has its own controls: no second set here.
          footer={narrow || stageOpen ? undefined : <VoiceBar />}
        />
  );
  const chatArea = (
        <ChatArea
          callStrip={!narrow && inCall ? <InCallStrip avatarFor={avatarFor} /> : undefined}
          channel={active}
          onRejoin={(name) => chat.rejoin(name)}
          // Prefer the live per-server IRC nick (collision-adjusted / NickServ /
          // server-forced renames differ from the global account nick). Falls
          // back to the passed-in nick before the server reports one.
          myNick={state.myNick || myNick}
          // Channels available for `#name` autocomplete / `/join` Tab-complete:
          // joined channels first (most relevant), then anything the server
          // advertised via LIST. De-duped, lowercase comparison.
          knownChannels={mergeKnownChannels(state.channels, state.channelDirectory.entries)}
          bannerError={bannerError}
          onDismissBanner={() => layoutBloc.dismissBanner()}
          onSend={(msg, opts) => (opts ? chat.input(msg, opts) : chat.input(msg))}
          serverHost={serverHost}
          onSendTo={(channel, msg) => chat.send(channel, msg)}
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
          onViewport={(name, atBottom) => chat.setViewport?.(name, atBottom)}
          // Live per-channel message signal for fine-grained re-renders. Guard
          // with typeof so hand-rolled test fakes (no messagesSignal) fall back
          // to rendering channel.messages from the snapshot.
          messagesSignal={
            active && typeof chat.messagesSignal === 'function' ? chat.messagesSignal(active.name) : null
          }
          replyContext={replyContext}
          onOpenChannelSettings={isChannel ? () => { setChannelSettingsTab('channel'); setChannelSettingsOpen(true); } : undefined}
          registration={registrationBadge && { ...registrationBadge, atRisk: regAtRisk && myRankHere >= OP }}
          registerPrompt={regAtRisk && myRankHere >= OP && active && !regPromptDismissed.has(active.name.toLowerCase()) ? {
            onRegister: () => { setChannelSettingsTab('registration'); setChannelSettingsOpen(true); },
            onDismiss: () => setRegPromptDismissed((s) => new Set(s).add(active.name.toLowerCase())),
          } : null}
          onOpenRegistration={isChannel ? () => { setChannelSettingsTab('registration'); setChannelSettingsOpen(true); } : undefined}
          // `typeof` guard: hand-rolled test fakes have no bouncerConnect.
          onBouncerConnect={typeof chat.bouncerConnect === 'function' ? () => chat.bouncerConnect() : undefined}
          onTrustBouncerCert={typeof chat.trustBouncerCert === 'function' ? () => chat.trustBouncerCert() : undefined}
          onRejectBouncerCert={typeof chat.rejectBouncerCert === 'function' ? () => chat.rejectBouncerCert() : undefined}
          onBack={narrow ? () => setFriendsUi({ phone: null }) : undefined}
          onShowMembers={narrow && isChannel ? () => setFriendsUi({ phone: 'members' }) : undefined}
          welcome={engineState === 'connected' && !hasConversations ? (
            <ServerWelcome
              serverName={serverName}
              description={serverDescription}
              channels={welcomeChannels(serverChannels ?? [], state.channelDirectory.entries)}
              onJoin={(name) => chat.join(name, { byUser: true })}
              onBrowse={() => setJoinRequest(true)}
            />
          ) : undefined}
          // One members toggle on every non-phone width: at mid width it
          // opens the overlay, wider it docks / undocks the column.
          membersShown={!narrow && isChannel ? (mid ? midPanel : membersOpen.open) : undefined}
          onToggleMembers={!narrow && isChannel ? (mid ? () => setMidPanel((o) => !o) : membersOpen.toggle) : undefined}
          searchOpen={searchOpen}
          onOpenSearch={active ? openSearch : undefined}
          searchPage={searchPage}
          searchJump={searchJump}
          onBackToResults={() => { setSearchRestoring(true); setSearchOpen(true); }}
          onDismissSearchJump={() => setSearchJump(null)}
          onOpenThread={openThread}
          threadJump={threadJump}
        />
  );
  const threadPanel = threadRoot && active ? (
        <ThreadPanel
          key={activeKey}
          rootId={threadRoot}
          messages={searchMessages}
          channelName={active.name}
          myNick={selfNick}
          members={active.members}
          knownChannels={mergeKnownChannels(state.channels, state.channelDirectory.entries)}
          avatarFor={avatarFor}
          nickActions={nickActions}
          replyContext={replyContext}
          onSend={(msg, opts) => (opts ? chat.input(msg, opts) : chat.input(msg))}
          onTyping={(typing) => { if (state.activeChannel) chat.sendTyping(state.activeChannel, typing); }}
          onClose={closeThread}
          onJumpTo={(m) => {
            setThreadJump((j) => ({ id: m.id, seq: (j?.seq ?? 0) + 1 }));
            // A phone's sheet covers the conversation: back to it.
            if (narrow) setThread(null);
          }}
          variant={narrow ? 'sheet' : 'side'}
          width={threadW}
          disabled={isChannel && !active.joined && engineState === 'connected'}
        />
  ) : null;
  const threadHandle = (
    <ResizeHandle
      side="right"
      width={threadW}
      min={PANEL_BOUNDS.thread.min}
      max={PANEL_BOUNDS.thread.max}
      onChange={setThreadW}
      onCommit={(w) => setThreadW(setPanelWidth('thread', w))}
      onReset={() => setThreadW(setPanelWidth('thread', PANEL_BOUNDS.thread.def))}
      ariaLabel="Resize thread"
    />
  );
  const userPanel = (
        <UserPanel
          channel={active}
          nickActions={nickActions}
          avatarFor={avatarFor}
          width={membersW}
          onBack={narrow ? () => setFriendsUi({ phone: 'chat' }) : undefined}
        />
  );

  const membersHandle = (
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
  );

  // Phones: each screen, the ones a swipe leads to (back to the channel
  // list, forward to the conversation or its members), and the swipe.
  const phoneScreen = (p: PhonePageId | null) => p === null ? (
    <div class="phone-home">
      {rail}
      {friendsUi.my ? mySidebar : sidebar}
    </div>
  ) : p === 'chat' ? chatArea
    : p === 'members' ? userPanel
      : p === 'friends' ? (
        <PhonePage title="Friends" sub={friendsSub(friendsSnap)} backLabel="Back to MY" onBack={() => setFriendsUi({ phone: null })}>
          <FriendsView layout="phone" />
        </PhonePage>
      ) : p === 'calls' ? (
        <PhonePage title="Calls" sub="live · recent" backLabel="Back to MY" onBack={() => setFriendsUi({ phone: null })}>
          {calls('phone')}
        </PhonePage>
      ) : null;
  const phoneBack: PhonePageId | null | undefined = phonePage === null ? undefined : phonePage === 'members' ? 'chat' : null;
  const phoneForward: PhonePageId | undefined = phonePage === null ? (active && !friendsUi.my ? 'chat' : undefined)
    : phonePage === 'chat' && isChannel ? 'members' : undefined;
  const swipe = useSwipeNav(phoneRef, narrow && !phoneCallOpen && !searchOpen, phoneBack !== undefined, phoneForward !== undefined,
    (dir) => setFriendsUi({ phone: dir === 'back' ? phoneBack ?? null : phoneForward ?? null }));
  const phoneUnder = swipe.dir === 'back' ? phoneBack : swipe.dir === 'forward' ? phoneForward : undefined;
  const phoneLayers: Array<PhonePageId | null> = phoneUnder === undefined ? [phonePage] : [phoneUnder, phonePage];

  // The right-hand column: beside the main area on a desktop (the member list
  // only while `docked`: the header's members toggle, by default from
  // MEMBERS_AUTO_WIDTH up); at mid width an overlay over it, shown while
  // toggled on (the members toggle / Call chat button).
  const rightPanel = (panel: JSX.Element, handle: JSX.Element | null, docked = true) => !mid
    ? (docked ? <>{handle}{panel}</> : null)
    : midPanel ? (
      <div class="mid-panel-layer" onClick={() => setMidPanel(false)}>
        <div class="mid-panel" onClick={(e) => e.stopPropagation()}>{panel}</div>
      </div>
    ) : null;
  const midToggle = mid ? { open: midPanel, toggle: () => setMidPanel((o) => !o) } : undefined;
  const callStage = <CallStage avatarFor={avatarFor} people={callChat ? midToggle : undefined} />;

  return (
    <div
      class={`app-shell${narrow ? ` is-narrow phone-${phoneCallOpen ? 'call' : phonePage ?? 'home'}` : mid ? ' is-mid' : ''}`}
    >
      {narrow ? (
        <>
          {phoneCallOpen ? (
            <MobileCallScreen avatarFor={avatarFor}
              onChat={chatChannel ? () => { closeCall(); chat.setActive(chatChannel.name); setFriendsUi({ my: false, phone: 'chat' }); } : undefined} />
          ) : (
            <div class="phone-screen">
              <div class="phone-stack" ref={phoneRef}>
                {phoneLayers.map((p) => {
                  const cur = p === phonePage;
                  // The conversation (the main area) is always on top: from
                  // the channel list or the members it slides in over them,
                  // from the conversation the screen beneath shows as it
                  // slides away.
                  const mainOnTop = phoneUnder !== undefined && !isMainPage(phonePage) && isMainPage(phoneUnder);
                  const moving = swipe.dx !== null && (mainOnTop ? !cur : cur);
                  const width = phoneRef.current?.clientWidth ?? 0;
                  const x = !moving || swipe.dx === null ? 0
                    : mainOnTop ? swipe.dx + (swipe.dir === 'forward' ? width : -width) : swipe.dx;
                  const style = moving
                    ? { transform: `translateX(${x}px)`, transition: swipe.settling ? `transform ${SETTLE_MS}ms ease-out` : 'none' }
                    : undefined;
                  return (
                    <div key={p ?? 'home'} class={`phone-layer${cur ? ' phone-layer-cur' : ' phone-layer-under'}${moving ? ' phone-layer-top' : ''}`}
                      style={style} inert={!cur} aria-hidden={cur ? undefined : true}>
                      {phoneScreen(p)}
                    </div>
                  );
                })}
              </div>
              {/* In a voice call: minimized, at the bottom of every screen. */}
              <MobileMiniBar />
            </div>
          )}
          <VoiceJoinSheet self={myNick} avatarFor={avatarFor} />
          {/* A thread: a full-height sheet over the conversation. */}
          {phonePage === 'chat' && !phoneCallOpen && !searchOpen ? threadPanel : null}
        </>
      ) : (
        myOpen ? (
          <>
            {rail}
            {mySidebar}
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
            {stageOpen ? callStage
              : myView === 'friends' ? <FriendsView layout="desktop" />
                : myView === 'calls' ? calls('desktop')
                  : chatArea}
            {stageOpen ? (callChat ? rightPanel(<CallPanel chat={callChat} width={membersW} />, null) : null)
              : myView === 'chat' ? (threadPanel && !searchOpen ? rightPanel(threadPanel, threadHandle)
                : !active || isChannel ? rightPanel(userPanel, membersHandle, membersOpen.open && !searchOpen) : null) : null}
            <ScreenPicker />
          </>
        ) : <>
          {rail}
          {sidebar}
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
          {stageOpen ? callStage : prejoinOpen ? <VoicePreJoin self={myNick} avatarFor={avatarFor} people={midToggle} /> : chatArea}
          {/* In a call, its tiles show who's in: the right panel is the
              voice channel's text chat, if it has one. */}
          {stageOpen ? (callChat ? rightPanel(<CallPanel chat={callChat} width={membersW} />, membersHandle) : null)
            : prejoinOpen ? rightPanel(<PreJoinPeople avatarFor={avatarFor} width={membersW} />, membersHandle)
              : threadPanel && !searchOpen ? rightPanel(threadPanel, threadHandle)
                : (!active || isChannel ? rightPanel(userPanel, membersHandle, membersOpen.open && !searchOpen) : null)}
          <ScreenPicker />
        </>
      )}

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
              <Input
                inputSize="sm"
                value={kickReason}
                onInput={(e) => setKickReason((e.target as HTMLInputElement).value)}
                placeholder="e.g. spamming"
                // eslint-disable-next-line jsx-a11y/no-autofocus
                autofocus
              />
            </label>
            <div class="kick-modal-actions">
              <Button variant="ghost" size={narrow ? 'lg' : 'md'} class="kick-modal-cancel" onClick={() => setKickTarget(null)}>Cancel</Button>
              <Button
                variant="danger"
                size={narrow ? 'lg' : 'md'}
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
              </Button>
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
            myNick={state.myNick || myNick}
            serverId={activeServerId ?? undefined}
            onSetMode={(fragment) => chat.setChannelMode(active.name, fragment)}
            onSetTopic={(text) => chat.setTopic(active.name, text)}
            onAddBan={(mask) => chat.ban(active.name, mask)}
            onRemoveBan={(mask) => chat.unban(active.name, mask)}
            onRefresh={() => { chat.requestChannelModes(active.name); chat.requestBanList(active.name); }}
            key={`${active.name}:${channelSettingsTab}`}
            initialTab={channelSettingsTab}
            chanserv={csCtl && csState ? { ctl: csCtl, state: csState, myAccount, policy: channelPolicy } : undefined}
          />
        )}
      </Modal>
    </div>
  );
}

// Friends' page subtitle: "2 friends · 1 request".
function friendsSub(snap: { friends: readonly unknown[]; incoming: readonly unknown[] }): string {
  const f = snap.friends.length;
  const r = snap.incoming.length;
  return `${f} friend${f === 1 ? '' : 's'}${r ? ` · ${r} request${r === 1 ? '' : 's'}` : ''}`;
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
