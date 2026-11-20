import { NetworkAccountBar } from '../NetworkSignIn/NetworkAccountBar';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { ChatService, ChatState } from '../../modules/chat';
import { banMask } from '../../modules/chat';
import type { EngineState } from '../../modules/engine';
import { Button, Input, Modal } from '@boson/shared';
import { ServerRail, type ServerRailTile } from './ServerRail';
import { ChannelSidebar } from './ChannelSidebar';
import { VoiceSection } from './VoiceSection';
import { ChannelVoiceAdd, ChannelVoiceRooms } from './VoiceRooms';
import { VoiceBar } from './VoiceBar';
import { ChatArea } from './ChatArea';
import { UserPanel } from './UserPanel';
import { ChannelSettings, type ChannelSettingsTab } from './ChannelSettings';
import { useChannelPolicy, type ChanServState } from '../../modules/chanserv';
import { ResizeHandle } from './ResizeHandle';
import { getPanelWidth, setPanelWidth, PANEL_BOUNDS } from '../../modules/ui/panel-sizes';
import type { ChannelOpActions, NickProfiles } from './nick-actions';
import { useAvatarFor } from '../../shared/Avatar/use-avatar-for';
import { ChatLayoutBloc, type ChatLayoutState } from './ChatLayoutBloc';
import { isNarrow, useNarrow } from '../../shared/narrow';
import { MobileCallScreen, MobileMiniBar } from './MobileCall';
import { closeCall, isPrivateCall } from './call-shared';
import { VoiceJoinSheet, VoicePreJoin } from './PreJoin';
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
import { CallsView, MyRailTile, MySidebar, RailDivider, type MyDm, type Presence } from '../Friends/MySpace';
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
  onReorderChannels?: (names: string[]) => void;
  onResetChannelOrder?: () => void;
  // MY's direct messages (every connected server's), and opening one:
  // its server becomes the active one, with the conversation open.
  myDms?: readonly MyDm[];
  onOpenDm?: (serverId: string, name: string) => void;
}

// Phones: the launch has opened onto the last conversation (once per run).
let launchShown = false;

export function ChatLayout({
  chat, serverName, serverHost, bannerUrl, logoUrl, onToggleNetworkTheme, myNick, servers, activeServerId, onSelectServer, onBrowseServers,
  engineState = 'connected', onReconnect, onCancelReconnect, reconnectActive = false,
  connectionError, onOpenServerSettings, onLeaveServer, onBouncerConnect, onBouncerDisconnect,
  onReorderServers, channelOrder, onReorderChannels, onResetChannelOrder, myDms, onOpenDm,
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

  const isChannel = !!active && (active.name.startsWith('#') || active.name.startsWith('&'));

  // Phones (and narrow windows) show one screen at a time, like the
  // desktop's columns in turn: the rail with the channel list, or a page
  // full screen with a back arrow (the conversation, its members, Friends,
  // Calls). friends-ui's `phone` is the page.
  const narrow = useNarrow();
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
  const myAccount = typeof chat.selfIdentity === 'function' ? chat.selfIdentity().account : undefined;
  const activeJoined = !!active?.joined;
  useEffect(() => {
    if (csCtl && isChannel && active && activeJoined) csCtl.ensureInfo(active.name);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [csCtl, isChannel, active?.name, activeJoined, csState?.dialect, csState?.present]);
  const regInfo = csCtl && active && isChannel && csState?.present !== false ? csCtl.channel(active.name).info : undefined;
  const registrationBadge = regInfo && !regInfo.closed ? { registered: regInfo.registered, founder: regInfo.founder } : null;

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
    // WHOIS for the profile a click on a nick opens (absent on test fakes).
    const profiles: NickProfiles | undefined = typeof chat.requestWhois === 'function' ? {
      info: (n: string) => chat.whois.value.get(n.toLowerCase()),
      request: (n: string) => chat.requestWhois(n),
      seen: (n: string) => chat.seen?.get(n),
    } : undefined;
    return { onSendMessage: (nick: string) => chat.openDM(nick), ops, profiles };
  }, [chat, active, isChannel, supportsOwnerAdmin, myRankHere]);

  // Resolves a nick → profile-image URL for Boson members on this server
  // (own avatar + presence matches), shared by the chat stream + member list.
  const avatarFor = useAvatarFor(activeServerId ?? null);
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
  const presence: Presence = engineState !== 'connected' ? 'offline' : friendsSnap.privacy.doNotDisturb ? 'dnd' : 'online';
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
                onClick={() => setFriendsUi({ my: true })} />
              <RailDivider />
            </>
          )}
          onBrowseServers={onBrowseServers}
          onOpenServerSettings={onOpenServerSettings}
          onLeaveServer={onLeaveServer}
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
          onPart={(name) => chat.part(name)}
          channelOrder={channelOrder}
          serverId={activeServerId}
          onReorderChannels={onReorderChannels}
          onResetChannelOrder={onResetChannelOrder}
          channelDirectory={state.channelDirectory.entries}
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
          footer={narrow ? undefined : <VoiceBar />}
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
          onSend={(msg) => chat.input(msg)}
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
          onOpenChannelSettings={isChannel ? () => { setChannelSettingsTab('channel'); setChannelSettingsOpen(true); } : undefined}
          registration={registrationBadge}
          onOpenRegistration={isChannel ? () => { setChannelSettingsTab('registration'); setChannelSettingsOpen(true); } : undefined}
          // `typeof` guard: hand-rolled test fakes have no bouncerConnect.
          onBouncerConnect={typeof chat.bouncerConnect === 'function' ? () => chat.bouncerConnect() : undefined}
          onTrustBouncerCert={typeof chat.trustBouncerCert === 'function' ? () => chat.trustBouncerCert() : undefined}
          onRejectBouncerCert={typeof chat.rejectBouncerCert === 'function' ? () => chat.rejectBouncerCert() : undefined}
          onBack={narrow ? () => setFriendsUi({ phone: null }) : undefined}
          onShowMembers={narrow && isChannel ? () => setFriendsUi({ phone: 'members' }) : undefined}
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
  const swipe = useSwipeNav(phoneRef, narrow && !phoneCallOpen, phoneBack !== undefined, phoneForward !== undefined,
    (dir) => setFriendsUi({ phone: dir === 'back' ? phoneBack ?? null : phoneForward ?? null }));
  const phoneUnder = swipe.dir === 'back' ? phoneBack : swipe.dir === 'forward' ? phoneForward : undefined;
  const phoneLayers: Array<PhonePageId | null> = phoneUnder === undefined ? [phonePage] : [phoneUnder, phonePage];

  return (
    <div
      class={`app-shell${narrow ? ` is-narrow phone-${phoneCallOpen ? 'call' : phonePage ?? 'home'}` : ''}`}
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
                  const style = cur && swipe.dx !== null
                    ? { transform: `translateX(${swipe.dx}px)`, transition: swipe.settling ? `transform ${SETTLE_MS}ms ease-out` : 'none' }
                    : undefined;
                  return (
                    <div key={p ?? 'home'} class={`phone-layer${cur ? ' phone-layer-cur' : ' phone-layer-under'}`}
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
            {stageOpen ? <CallStage avatarFor={avatarFor} />
              : myView === 'friends' ? <FriendsView layout="desktop" />
                : myView === 'calls' ? calls('desktop')
                  : chatArea}
            {stageOpen ? <CallPanel chat={callChat} avatarFor={avatarFor} width={membersW} />
              : myView === 'chat' ? (
                <>
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
                  {userPanel}
                </>
              ) : null}
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
          {stageOpen ? <CallStage avatarFor={avatarFor} /> : prejoinOpen ? <VoicePreJoin self={myNick} avatarFor={avatarFor} /> : chatArea}
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
          {stageOpen ? <CallPanel chat={callChat} avatarFor={avatarFor} width={membersW} /> : userPanel}
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
