import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { Plus, SlidersHorizontal } from 'lucide-preact';
import { AuthError, describeAuthError, useAuthService, useAuthState, validateHandle } from '../../modules/auth';
import { sentence } from '../../modules/auth/wording';
import { HttpError } from '../../shared/http/http.client';
import { clearRecoveryPending, isRecoveryPending, markRecoveryPending } from '../../modules/identity/recovery-pending';
import type { DirectoryService } from '../../modules/directory';
import type { Server, User } from '../../modules/directory';
import type { NetworkDirectories } from '../../modules/directory/networks';
import type { Facets, NetworkSort } from '../../modules/directory/network-api';
import { subscribeAddServer, subscribeDeepLink } from '../../modules/deep-link/deep-link';
import { subscribeOpenConversation, subscribeReadMemo } from '../../modules/inbox-nav/inbox-nav';
import { subscribeOwnAvatar } from '../../modules/chat/avatar-cache';
import { onHandleChange } from '../../modules/ui/handle-change';
import { getBouncerStore } from '../../modules/chat/bouncer.store';
import type { EngineClient } from '../../modules/engine';
import type { ChatHistoryStore } from '../../modules/history';
import type { IdentityService } from '../../modules/identity';
import { RecoveryCodeReveal } from '../../components/RecoveryCodeReveal';
import { ChatLayout } from '../ChatLayout';
import { ServerRail } from '../ChatLayout/ServerRail';
import { ServerSettings } from '../ChatLayout/ServerSettings';
import { useNarrow } from '../../shared/narrow';
import { getVoiceController } from '../../modules/voice';
import { AtomLoader, Avatar, Badge, BarLoader, Button, EmptyState, Field, Input, ListRow, Modal, Select, StatusDot, Tabs, Toggle, WarningBanner } from '@boson/shared';
import { DirectoryBloc, type DirectoryState, activeConnection } from './DirectoryBloc';
import { findListing } from '../../modules/directory/listing-match';
import { joinsLabel } from '../../modules/directory/autojoin';
import { HostServerModal } from './HostServerModal';
import { useNetworkThemes } from '../../modules/ui/theme';
import { useNetworkThemeSync } from './network-theme-sync';
import type { ServerRailTile } from '../ChatLayout/ServerRail';
import type { MyDm } from '../Friends/MySpace';
import { SERVICE_CHANNEL } from '../../modules/chat/services';
import { startNotificationBridge, type VoiceScope } from '../../modules/notifications/bridge';
import { joinVoice, openCalls, openFriends } from '../Notifications/navigate';
import './DirectoryScreen.css';

interface Props {
  directory: DirectoryService;
  // Multi-directory browse + owner calls; absent: the legacy /servers list.
  networks?: NetworkDirectories;
  engine: EngineClient | null;
  identity: IdentityService;
  // Optional chat-history store. When provided, scrollback persists across
  // page reloads + sign-outs (the latter wipes it on the way out). The
  // production app.tsx wires this to IDBChatHistoryStore; tests can leave it
  // unset and chat behaves exactly as before.
  history?: ChatHistoryStore;
  // Guest mode: when present, the bloc skips backend /me + identity unlock
  // gates and synthesises a User from this nick.
  guestNick?: string;
}

const LANGUAGE_FILTERS = [
  { id: 'all', label: 'All' },
  { id: 'en', label: 'English' },
  { id: 'es', label: 'Español' },
  { id: 'ja', label: '日本語' },
];

// How many language chips the directory's facets earn (the rest are in
// reach through search); the selected one always stays visible.
const MAX_LANGUAGE_CHIPS = 6;

const SORTS: ReadonlyArray<{ id: NetworkSort | ''; label: string }> = [
  { id: '', label: 'Recommended' },
  { id: 'users', label: 'Most users' },
  { id: 'active', label: 'Recently active' },
  { id: 'newest', label: 'Newest' },
  { id: 'name', label: 'Name' },
];

// A language code's own name ("es" → "Español"), else the code.
function languageLabel(code: string): string {
  const known = LANGUAGE_FILTERS.find((f) => f.id === code);
  if (known) return known.label;
  try {
    const name = new Intl.DisplayNames([code], { type: 'language' }).of(code);
    if (name && name.toLowerCase() !== code.toLowerCase()) return name.charAt(0).toUpperCase() + name.slice(1);
  } catch { /* not a valid tag */ }
  return code;
}

// Language chips: from the directories' facets when there are any.
const VIEW_TABS = [{ id: 'directory', label: 'Directory' }, { id: 'bouncer', label: 'Bouncer' }];

export function languageChips(facets: Facets | null, selected: string): Array<{ id: string; label: string }> {
  if (!facets || facets.languages.length === 0) return LANGUAGE_FILTERS;
  const ids = facets.languages.slice(0, MAX_LANGUAGE_CHIPS).map((l) => l.value);
  if (selected !== 'all' && !ids.includes(selected)) ids.push(selected);
  return [{ id: 'all', label: 'All' }, ...ids.map((id) => ({ id, label: languageLabel(id) }))];
}

// Calls `onVisible` while the element is on screen (infinite scroll).
function LoadMoreSentinel({ onVisible }: { onVisible: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const cb = useRef(onVisible);
  cb.current = onVisible;
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) cb.current();
    }, { rootMargin: '400px 0px' });
    io.observe(el);
    return () => io.disconnect();
  }, []);
  return <div ref={ref} class="directory-more-sentinel" aria-hidden="true" />;
}

export function DirectoryScreen({ directory, networks, engine, identity, history, guestNick }: Props) {
  const auth = useAuthService();
  const authState = useAuthState();
  // Sign-up's recovery-code step wasn't confirmed (the page reloaded on it):
  // it comes back before the directory.
  const sessionUserId = authState.session?.user?.id ?? '';
  const [recoveryPending, setRecoveryPending] = useState(() => !guestNick && isRecoveryPending(sessionUserId));
  useEffect(() => {
    setRecoveryPending(!guestNick && isRecoveryPending(sessionUserId));
  }, [sessionUserId, guestNick]);

  // guestNick is intentionally NOT in the dep array: flipping between guest
  // and account modes feeds in through `bloc.setIdentity()` below so the
  // same bloc instance survives the transition. Recreating the bloc would
  // tear down all ChatServices + state subscriptions, leaving the live
  // engine sessions orphaned and the user staring at a stuck-connecting UI.
  const bloc = useMemo(
    () => new DirectoryBloc({
      auth,
      directory,
      networks,
      identity,
      engine,
      history,
      guestNick,
      // Use a function so the bloc reads the live userId at the moment it
      // constructs the ChatService. In guest mode no account session
      // exists; ChatService falls back to its in-memory log behaviour.
      getUserId: () => auth.getState().session?.user?.id ?? null,
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- guestNick is
    // propagated via setIdentity, not by recreating the bloc.
    [auth, directory, networks, identity, engine, history],
  );
  useEffect(() => () => bloc.dispose(), [bloc]);
  // Propagate guestNick changes into the existing bloc. The first effect
  // run during initial mount is a no-op (setIdentity is short-circuited by
  // the equality check when the bloc was just constructed with this same
  // value); subsequent runs fire on real identity flips.
  useEffect(() => {
    bloc.setIdentity({ guestNick: guestNick ?? null });
  }, [bloc, guestNick]);
  // Deep-link join. The marketing site's /discover page produces
  // `boson://join?host=…&port=…&tls=1` URLs; the bridge captures them
  // (including cold-start cases) and replays the most recent one to
  // every new subscriber here. The bloc handles the rest — matches an
  // existing directory entry by host:port if available, otherwise
  // mints a local server and connects.
  useEffect(() => {
    return subscribeDeepLink((params) => {
      void bloc.joinFromDeepLink(params);
    });
  }, [bloc]);

  // Inbox click-through: focus the entry's server + open the conversation.
  useEffect(() => {
    return subscribeOpenConversation(({ serverId, target }) => {
      bloc.openConversation(serverId, target);
    });
  }, [bloc]);

  // Inbox memo open: fetch the memo body on demand (issues READ <n> to
  // the originating server) without leaving the inbox.
  useEffect(() => {
    return subscribeReadMemo(({ serverId, memoIndex }) => {
      bloc.readMemo(serverId, memoIndex);
    });
  }, [bloc]);

  // Handle renamed in Settings: it's the nick, so rename on the servers
  // the user is on now.
  useEffect(() => onHandleChange((h) => bloc.setHandle(h)), [bloc]);

  // Profile-image change (Settings upload/remove): refresh the signed-in
  // user's avatar across open connections live, no reconnect.
  useEffect(() => {
    return subscribeOwnAvatar((url) => bloc.setOwnAvatar(url));
  }, [bloc]);

  const [state, setState] = useState<DirectoryState>(() => bloc.getState());
  useEffect(() => bloc.subscribe(setState), [bloc]);

  // Full-page Server settings overlay — populated when the user right-clicks
  // a server-rail tile and picks "Server details". Null otherwise; we render
  // the normal chat layout. The id is the connection's serverId.
  const [serverSettingsForId, setServerSettingsForId] = useState<string | null>(null);
  // Phones: server settings take the whole screen, without the rail.
  const narrow = useNarrow();

  const { me, showChat, restoring, serverBrowserOpen, connections, activeServerId } = state;
  // Private calls need a voice server of the account's network: find out
  // which connected servers have one, not only the one on screen (a call
  // can ring, and be made from Friends, while another server is open).
  const connectedHosts = connections.filter((c) => c.engineState === 'connected').map((c) => c.server.hostname).sort().join(' ');
  useEffect(() => {
    const voice = getVoiceController();
    if (!voice) return;
    for (const host of connectedHosts.split(' ')) if (host) void voice.discover(host);
  }, [connectedHosts]);
  const active = activeConnection(state);
  // Friend and call notifications (requests, missed calls, calls starting
  // in voice channels you're in): which servers you're on, and where.
  const scopeRef = useRef<VoiceScope[]>([]);
  scopeRef.current = connections.filter((c) => c.engineState === 'connected').map((c) => ({
    host: c.server.hostname,
    serverId: c.serverId,
    serverName: c.server.name,
    channels: c.chat.getState().channels.filter((ch) => /^[#&]/.test(ch.name) && ch.joined).map((ch) => ch.name.toLowerCase()),
  }));
  useEffect(() => startNotificationBridge({
    scope: () => scopeRef.current,
    open: { friends: openFriends, calls: openCalls, voice: joinVoice },
  }), []);

  // Network themes: the active server's applies (in chat and its settings);
  // each network's is looked up when it connects.
  const themes = useNetworkThemes();
  useNetworkThemeSync(themes, connections, (c) => resolveListing(c, state.servers, state.listings[c.serverId]),
    active && (showChat || serverSettingsForId !== null) ? active.server.hostname : null);
  const railTiles = (): ServerRailTile[] => connections.map((c) => {
    // Aggregate unread + mention counts across every channel in this
    // server, so the rail badge reflects total activity at a glance.
    // chat.getState() is cheap here — it's already memoized snapshots.
    const chs = c.chat.getState().channels;
    let unread = 0;
    let mentions = 0;
    for (const ch of chs) { unread += ch.unread; mentions += ch.mentions; }
    const brand = themes.brandingFor(c.server.hostname);
    return {
      serverId: c.serverId,
      name: c.server.name,
      host: c.server.hostname,
      engineState: c.engineState,
      bouncerUpstream: c.bouncerUpstream,
      unread,
      mentions,
      // The network's own logo (its theme), else the directory icon.
      iconUrl: brand.logo ?? resolveServerImages(c, state.servers, state.listings[c.serverId]).iconUrl,
      ...(brand.available ? { networkTheme: { enabled: brand.enabled } } : {}),
    };
  });
  // MY's direct messages: every connected server's, in rail order.
  const myDms = (): MyDm[] => {
    const out: MyDm[] = [];
    for (const c of connections) {
      for (const ch of c.chat.getState().channels) {
        if (/^[#&]/.test(ch.name) || ch.name === SERVICE_CHANNEL) continue;
        out.push({ serverId: c.serverId, serverName: c.server.name, name: ch.name, unread: ch.unread, mentions: ch.mentions });
      }
    }
    return out;
  };
  const toggleNetworkTheme = (serverId: string, on: boolean): void => {
    const c = connections.find((x) => x.serverId === serverId);
    if (c) themes.setNetworkEnabled(c.server.hostname, on);
  };

  // If the user opens server-settings, replace the channel sidebar + chat
  // area + user panel with the settings page. The server rail stays so the
  // user can switch servers (which closes settings) or open settings for a
  // different server via right-click. On a phone the page is full screen
  // instead: the rail would leave it a sliver, and its back button returns.
  if (serverSettingsForId !== null) {
    const target = connections.find((c) => c.serverId === serverSettingsForId);
    if (!target || !me?.handle) {
      setServerSettingsForId(null);
    } else {
      const chatState = target.chat.getState();
      const listing = resolveListing(target, state.servers, state.listings[target.serverId]);
      return (
        <div class="app-shell">
          {!narrow && <ServerRail
            servers={railTiles()}
            onToggleNetworkTheme={toggleNetworkTheme}
            activeServerId={activeServerId}
            // Clicking a different server tile exits settings and returns
            // to chat for that server. Clicking the same tile is a no-op.
            onSelectServer={(id) => {
              if (id !== serverSettingsForId) setServerSettingsForId(null);
              bloc.setActiveServer(id);
            }}
            onBrowseServers={() => bloc.openServerBrowser()}
            // Right-click on another tile switches the settings page to it.
            onOpenServerSettings={(id) => setServerSettingsForId(id)}
            onBouncerConnect={(id) => bloc.bouncerConnect(id)}
            onBouncerDisconnect={(id) => bloc.bouncerDisconnect(id)}
            onReorderServers={(ids) => bloc.reorderServers(ids)}
          />}
          <ServerSettings
            serverDisplayName={target.server.name}
            serverDescription={listing?.description}
            serverWebsite={listing?.website_url}
            myNick={chatState.myNick || me.handle}
            serverInfo={chatState.serverInfo}
            serverLog={chatState.serverLog}
            onClearServerLog={() => target.chat.clearServerLog()}
            onClose={() => setServerSettingsForId(null)}
            onReconnect={() => {
              if (state.activeServerId !== serverSettingsForId) {
                bloc.setActiveServer(serverSettingsForId);
              }
              void bloc.reconnectActive();
            }}
            onDisconnect={() => {
              bloc.disconnect(serverSettingsForId);
              setServerSettingsForId(null);
            }}
            onChangeNick={(nick) => target.chat.changeNick(nick)}
            serverId={target.serverId}
            servicesFramework={chatState.servicesFramework}
            isOper={chatState.myOper}
            bouncerRoute={bloc.getServerBouncer(target.serverId)}
            bouncerGloballyEnabled={getBouncerStore().get()?.enabled ?? false}
            onSaveBouncerRoute={(route) => bloc.setServerBouncer(target.serverId, route)}
            // Only meaningful while attached via the bouncer — a stale value
            // from a dropped link would misreport the network state.
            bouncerUpstream={target.engineState === 'connected' ? target.bouncerUpstream : null}
            onBouncerConnect={() => bloc.bouncerConnect(target.serverId)}
            onBouncerDisconnect={() => bloc.bouncerDisconnect(target.serverId)}
            onTriggerAutoIdentify={() => target.chat.triggerAutoIdentify()}
            onRunCommand={(line) => target.chat.input(line)}
            onDropAccount={(acct, pw) => target.chat.dropAccount(acct, pw)}
            onIdentifyAccount={(pw) => target.chat.identifyAccount(pw)}
            onRegisterAccount={(pw, em) => target.chat.registerAccount(pw, em)}
            onConfirmAccount={(acct, code) => target.chat.confirmAccount(acct, code)}
            onResendConfirmation={(acct) => target.chat.resendConfirmation(acct)}
            supportsResend={target.chat.supportsResendConfirmation()}
            onClaimNick={(acct, opts) => target.chat.claimNick(acct, opts)}
            onDetectAccountState={(acct) => target.chat.detectAccountState(acct)}
            onResumeConfirmation={(acct, opts) => target.chat.resumePendingConfirmation(acct, opts)}
            // Guests get a synthetic `me` (id __guest__) but no Boson account: no
            // backend nick-claim, no E2E-encrypted password sync.
            signedIn={Boolean(me) && !guestNick}
            // The network admin turned automatic nick claims off: the
            // Identity panel shows the manual NickServ form with a note.
            nickClaimDisabled={state.nickClaimEnabled === false}
            // Ownership check: render the Edit tab only when the signed-in
            // account owns the row. The connection may hold a cold-start
            // SavedServer snapshot (no profile fields); buildEditableProps
            // resolves the full directory Server by id from state.servers
            // so an owner reconnecting from a saved session still gets the
            // Edit tab. Non-owners / unresolved rows short-circuit to plain
            // ServerSettings — the tab simply doesn't appear in the menu.
            {...buildEditableProps(target.server, me, bloc, state.servers, state.listings[target.serverId])}
            networkTheme={themes.brandingFor(target.server.hostname).available ? {
              enabled: themes.isNetworkEnabled(target.server.hostname),
              globallyEnabled: themes.globallyEnabled,
              onToggle: (on) => themes.setNetworkEnabled(target.server.hostname, on),
            } : undefined}
          />
        </div>
      );
    }
  }

  if (showChat && active && me?.handle) {
    const activeListing = resolveListing(active, state.servers, state.listings[active.serverId]);
    return (
      <>
        <ChatLayout
          chat={active.chat}
          serverName={active.server.name}
          serverHost={active.server.hostname}
          myNick={me.handle}
          servers={railTiles()}
          myDms={myDms()}
          onOpenDm={(serverId, name) => { bloc.openConversation(serverId, name); }}
          activeServerId={activeServerId}
          bannerUrl={resolveServerImages(active, state.servers, state.listings[active.serverId]).bannerUrl}
          logoUrl={themes.brandingFor(active.server.hostname).logo}
          onToggleNetworkTheme={toggleNetworkTheme}
          onSelectServer={(id) => bloc.setActiveServer(id)}
          onBrowseServers={() => bloc.openServerBrowser()}
          engineState={active.engineState}
          onReconnect={() => { void bloc.reconnectActive(); }}
          onCancelReconnect={() => bloc.cancelReconnectActive()}
          reconnectActive={active.reconnect.active}
          connectionError={active.error}
          onOpenServerSettings={(id) => setServerSettingsForId(id)}
          onLeaveServer={(id) => bloc.disconnect(id)}
          onBouncerConnect={(id) => bloc.bouncerConnect(id)}
          onBouncerDisconnect={(id) => bloc.bouncerDisconnect(id)}
          onReorderServers={(ids) => bloc.reorderServers(ids)}
          channelOrder={bloc.channelOrder(active.serverId)}
          onReorderChannels={(names) => bloc.reorderChannels(active.serverId, names)}
          onResetChannelOrder={() => bloc.resetChannelOrder(active.serverId)}
          serverDescription={activeListing?.description}
          serverChannels={activeListing ? [...(activeListing.autojoin_channels ?? []), ...(activeListing.channels ?? [])] : undefined}
        />
        <Modal
          open={serverBrowserOpen}
          onClose={() => bloc.closeServerBrowser()}
          title="Connect to a server"
          size="wide"
        >
          <div class="directory-modal-body">
            <DirectoryBody
              bloc={bloc}
              state={state}
              engine={engine}
              directory={directory}
              networks={networks}
              identity={identity}
            />
          </div>
        </Modal>
      </>
    );
  }

  // Saved-session restore in progress — show a splash instead of the
  // directory list so the user doesn't see it flash before chat loads.
  if (restoring) {
    const target = active?.server.name ?? 'last server';
    return (
      <div class="directory-screen directory-restoring">
        <div class="directory-restoring-inner">
          <div class="directory-prompt">$ boson reconnect</div>
          <div class="directory-restoring-text">Reconnecting to {target}…</div>
          <Button variant="ghost" onClick={() => bloc.disconnectAndBrowse()}>Cancel</Button>
        </div>
      </div>
    );
  }

  return (
    <div class="directory-screen">
      <div class="directory-container">
        {recoveryPending && me && identity.isUnlocked() ? (
          <div class="directory-setup-stage">
            <RecoveryResume
              directory={directory}
              identity={identity}
              onDone={() => { clearRecoveryPending(sessionUserId); setRecoveryPending(false); }}
            />
          </div>
        ) : (
          <DirectoryBody
            bloc={bloc}
            state={state}
            engine={engine}
            directory={directory}
            networks={networks}
            identity={identity}
          />
        )}
      </div>
    </div>
  );
}

interface DirectoryBodyProps {
  bloc: DirectoryBloc;
  state: DirectoryState;
  engine: EngineClient | null;
  directory: DirectoryService;
  networks?: NetworkDirectories;
  identity: IdentityService;
}

// Renders the search + filters + server list. Shared between the standalone
// directory screen and the modal overlay variant so the two views stay in
// lockstep (no risk of drift between "browsing for the first time" and
// "browsing to switch servers mid-chat").
function DirectoryBody({ bloc, state, engine, directory, networks, identity }: DirectoryBodyProps) {
  const {
    me, servers, filteredServers, query, language, showNsfw, error, connections, searching,
    tag, sort, facets, hasMore, loadingMore, legacyDirectory, directoryFailures, serverFilters,
  } = state;
  // First-launch-after-confirmation: the user has a session but no row
  // in /me yet — they need to pick a handle before anything else makes
  // sense. Render ONLY the setup prompt; the directory comes back as
  // soon as bloc.setMe runs with a non-null user. (Previously the
  // prompt rendered ABOVE the directory and visually stacked.)
  if (me === null) {
    return (
      <div class="directory-setup-stage">
        {error && <WarningBanner tone="danger" title="Couldn't load directory">{error}</WarningBanner>}
        <SetupPrompt directory={directory} identity={identity} onDone={(u) => bloc.setMe(u)} />
      </div>
    );
  }
  // Map of serverId → that connection's engineState, used by ServerRow to
  // render the "Currently connected" / "Joined" affordances.
  const connectionByServerId = new Map(connections.map((c) => [c.serverId, c]));
  // "Add by address": a server that isn't listed (stored on this device).
  const [addOpen, setAddOpen] = useState(false);
  // The manual-add form's hostname when opened from the login screen's
  // "Chat there as a regular IRC server".
  const [addHost, setAddHost] = useState('');
  useEffect(() => subscribeAddServer(({ hostname }) => {
    setAddHost(hostname);
    setAddOpen(true);
  }), []);
  const [hostOpen, setHostOpen] = useState(false);
  // Phones: the filters fold behind a Filters button, so the first server
  // shows without scrolling; the button says how many are set.
  const narrow = useNarrow();
  const [filtersOpen, setFiltersOpen] = useState(false);
  const activeFilters = (language !== 'all' ? 1 : 0) + (tag ? 1 : 0) + (sort ? 1 : 0) + (showNsfw ? 1 : 0);
  const filtersShown = !narrow || filtersOpen;
  // A card's details (description, channels, Connect).
  const [detailsId, setDetailsId] = useState<string | null>(null);
  const details = detailsId ? filteredServers?.find((s) => s.id === detailsId) ?? null : null;
  // Top-level view: the public directory, or the user's bouncer networks.
  // The Bouncer view is for people who set one up (User settings →
  // Bouncer); everyone else just sees the directory.
  const [view, setView] = useState<'directory' | 'bouncer'>('directory');
  const [bouncer, setBouncer] = useState(() => getBouncerStore().get());
  useEffect(() => getBouncerStore().subscribe(setBouncer), []);
  const showBouncer = !!bouncer?.enabled || bloc.bouncerNetworks().length > 0 || view === 'bouncer';
  const connect = (s: Server, join?: string): void => {
    setDetailsId(null);
    void bloc.connect(s, join ? { join } : {});
  };
  const anyConnected = connections.some((c) => c.engineState === 'connected');
  return (
    <>
      {error && (
        <WarningBanner tone="danger" title="Couldn't load directory">{error}</WarningBanner>
      )}

      {showBouncer && (
        <div class="directory-viewtabs">
          <Tabs
            label="Directory view"
            tabs={VIEW_TABS}
            active={view}
            onChange={(id) => setView(id as 'directory' | 'bouncer')}
          />
        </div>
      )}

      {view === 'bouncer' && (
        <BouncerNetworksPanel bloc={bloc} connections={connections} />
      )}

      {view === 'directory' && (<>
      <div class="directory-header">
        <div class="directory-header-row">
          <h1 class="directory-title">Server Directory</h1>
          <div class="directory-header-actions">
            {anyConnected && !state.showChat && (
              <Button variant="secondary" size="sm" onClick={() => bloc.openChat()}>Back to chat</Button>
            )}
            <Button
              variant="ghost"
              size="sm"
              onClick={() => bloc.refreshDirectory()}
              title="Refetch the directory from the backend"
            >
              Refresh
            </Button>
            {/* Listing a server needs a boson.chat account (guests have no
                row in /me, so registering would 401). */}
            {me && me.id !== '__guest__' && (
              <Button variant="ghost" size="sm" class="directory-host-cta" onClick={() => setHostOpen(true)}>
                Add your server to the community
              </Button>
            )}
          </div>
        </div>
        {!narrow && <p class="directory-desc">Find a community to chat in.</p>}
      </div>

      <div class="directory-search">
        <Input
          type="text"
          placeholder="Search servers…"
          value={query}
          onInput={(e) => bloc.setQuery((e.target as HTMLInputElement).value)}
          onKeyDown={(e) => { if (e.key === 'Escape' && query) { e.stopPropagation(); bloc.setQuery(''); } }}
          aria-label="Search servers"
          autoComplete="off"
          spellcheck={false}
        />
      </div>

      <div class={`directory-filters${narrow ? ' directory-filters-phone' : ''}`}>
        {narrow && (
          <div class="directory-filters-bar">
            <Button
              variant="secondary"
              pressed={filtersOpen}
              aria-expanded={filtersOpen}
              aria-controls="directory-filter-panel"
              icon={<SlidersHorizontal aria-hidden="true" />}
              onClick={() => setFiltersOpen((v) => !v)}
            >
              {activeFilters > 0 ? `Filters · ${activeFilters}` : 'Filters'}
            </Button>
            <Button
            variant="ghost"
            class="directory-add-address"
            onClick={() => { setAddHost(''); setAddOpen(true); }}
            title="Connect to a server that isn't listed here"
            icon={<Plus aria-hidden="true" />}
          >
            Add by address
          </Button>
          </div>
        )}

        {filtersShown && (<div class="directory-filter-panel" id="directory-filter-panel">
        <div class="directory-lang-chips" role="tablist" aria-label="Filter by language">
          {languageChips(facets, language).map((f) => (
            <Button
              key={f.id}
              variant="secondary"
              size="sm"
              tone={language === f.id ? 'accent' : undefined}
              role="tab"
              aria-selected={language === f.id}
              onClick={() => bloc.setLanguage(f.id)}
            >
              {f.label}
            </Button>
          ))}
        </div>

        {serverFilters && facets && facets.tags.length > 0 && (
          <Select
            size="sm"
            class="directory-select"
            label="Filter by topic"
            value={tag}
            options={[
              { value: '', label: 'Any topic' },
              ...facets.tags.slice(0, 40).map((t) => ({ value: t.value, label: `${t.value}${t.count ? ` (${t.count})` : ''}` })),
              ...(tag && !facets.tags.slice(0, 40).some((t) => t.value === tag) ? [{ value: tag, label: tag }] : []),
            ]}
            onChange={(v) => bloc.setTag(v)}
          />
        )}

        {serverFilters && (
          <Select
            size="sm"
            class="directory-select"
            label="Sort servers"
            value={sort}
            options={SORTS.map((o) => ({ value: o.id, label: o.label }))}
            onChange={(v) => bloc.setSort(v)}
          />
        )}

        <Toggle checked={showNsfw} onChange={(v) => bloc.setShowNsfw(v)} label="Show NSFW" />
        </div>)}

        {!narrow && (
          <Button
            variant="ghost"
            size="sm"
            class="directory-add-address"
            onClick={() => { setAddHost(''); setAddOpen(true); }}
            title="Connect to a server that isn't listed here"
            icon={<Plus aria-hidden="true" />}
          >
            Add by address
          </Button>
        )}
      </div>

      <Modal open={addOpen} onClose={() => setAddOpen(false)} title="Add a server by address">
        <AddLocalServerForm
          key={addHost}
          initialHostname={addHost}
          onSubmit={(input) => {
            bloc.addLocalServer(input);
            setAddOpen(false);
          }}
          onCancel={() => setAddOpen(false)}
        />
      </Modal>

      <ServerDetails
        server={details}
        connected={!!details && connectionByServerId.get(details.id)?.engineState === 'connected'}
        canConnect={!!engine && !!me?.handle}
        onConnect={connect}
        onClose={() => setDetailsId(null)}
      />

      <HostServerModal
        open={hostOpen}
        onClose={() => {
          setHostOpen(false);
          // The user may have registered + verified a new server while
          // the modal was open — that row only enters the public
          // /servers list once it hits "verified" status, and the
          // grid behind the modal is otherwise stale until the next
          // search-debounce fires. Force a refetch on close so the
          // new card is visible immediately.
          bloc.refreshDirectory();
        }}
        directory={directory}
        networks={networks}
      />

      {legacyDirectory && (
        <p class="directory-source-note" role="status">
          The network directory didn’t answer, so this is the older boson.chat list. It may be missing new servers.
        </p>
      )}
      {!legacyDirectory && directoryFailures.length > 0 && (filteredServers?.length ?? 0) > 0 && (
        <p class="directory-source-note" role="status">
          Couldn’t reach {directoryFailures.map((f) => f.source).join(', ')}. Showing servers from your other directories.
        </p>
      )}

      {/* Refetch (search / filters / Refresh) while results are on screen:
          a shimmer above the list instead of swapping it for a spinner. */}
      {searching && filteredServers !== null && (
        <BarLoader class="directory-refetch-bar" label="Updating results" />
      )}
      {filteredServers === null ? (
        <div class="directory-loading">
          <AtomLoader size={32} />
          <span>Loading directory…</span>
        </div>
      ) : filteredServers.length === 0 ? (
        <EmptyState
          class="directory-empty"
          action={(
            <div class="directory-empty-actions">
              {(query.trim() || language !== 'all' || tag) && (
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => { bloc.setQuery(''); if (language !== 'all') bloc.setLanguage('all'); if (tag) bloc.setTag(''); }}
                >
                  {query.trim() ? 'Clear search' : 'Clear filters'}
                </Button>
              )}
              <Button variant="ghost" size="sm" onClick={() => { setAddHost(''); setAddOpen(true); }}>
                Add a server by address
              </Button>
            </div>
          )}
        >
          {/* The directories filter by language/topic themselves, so an empty
              page with a chip on means the filters, not the search. */}
          {(servers && servers.length > 0) || language !== 'all' || tag
            ? 'No servers match these filters.'
            : 'No servers found.'}
        </EmptyState>
      ) : (
        <div class="directory-grid" role="list">
          {filteredServers.map((s) => {
            const conn = connectionByServerId.get(s.id);
            const isLocal = s.id.startsWith('local-');
            return (
              <ServerCard
                key={s.id}
                server={s}
                engine={engine}
                connected={conn?.engineState === 'connected'}
                isCurrent={!!conn}
                myHandle={me?.handle}
                onConnect={() => connect(s)}
                onOpen={() => setDetailsId(s.id)}
                isLocal={isLocal}
                onRemove={() => bloc.removeLocalServer(s.id)}
                // The default directory goes without saying; others are named.
                showSource={!!s.source && !s.source.isDefault}
              />
            );
          })}
        </div>
      )}
      {filteredServers !== null && hasMore && !searching && (
        <div class="directory-more">
          {/* Re-keyed per page so a still-visible sentinel fires again. */}
          <LoadMoreSentinel key={filteredServers.length} onVisible={() => { void bloc.loadMore(); }} />
          {loadingMore
            ? <BarLoader class="directory-more-bar" label="Loading more servers" />
            : <Button variant="ghost" onClick={() => { void bloc.loadMore(); }}>Load more servers</Button>}
        </div>
      )}
      </>)}
    </>
  );
}

// The "Bouncer" view of the server browser: lists the user's bouncer networks
// (saved-session servers routed through their global ZNC profile) with connect
// / remove, plus a one-field add form. Networks added here sync across devices
// via the session payload. When no global bouncer is configured it nudges the
// user to User Settings → Bouncer.
// Status + primary action for one saved bouncer network. "Connected" must
// mean the bouncer is on the real network, not merely that we reached the
// bouncer: an attached-but-offline bouncer reads "Network offline" with a
// Connect network action.
function BouncerNetworkStatus({ conn, onConnect, onConnectUpstream }: {
  conn: DirectoryState['connections'][number] | undefined;
  onConnect: () => void;
  onConnectUpstream: () => void;
}) {
  if (conn?.engineState === 'connecting') {
    return <Badge tone="info">Connecting…</Badge>;
  }
  if (conn?.engineState !== 'connected') {
    return (
      <Button variant="primary" onClick={onConnect}>
        Connect
      </Button>
    );
  }
  switch (conn.bouncerUpstream) {
    case 'disconnected':
      return (
        <>
          <Badge tone="warn">Network offline</Badge>
          <Button variant="primary" onClick={onConnectUpstream}>
            Connect network
          </Button>
        </>
      );
    case 'connecting':
      return <Badge tone="info">Connecting…</Badge>;
    default:
      // 'connected', or not reported (an engine without upstream tracking).
      return <Badge tone="success">Connected</Badge>;
  }
}

export function BouncerNetworksPanel({ bloc, connections }: {
  bloc: DirectoryBloc;
  connections: DirectoryState['connections'];
}) {
  const [profile, setProfile] = useState(() => getBouncerStore().get());
  useEffect(() => getBouncerStore().subscribe(setProfile), []);
  const [name, setName] = useState('');
  const [network, setNetwork] = useState('');
  // Discovery ("Pull from bouncer") state machine.
  const [discovering, setDiscovering] = useState(false);
  const [discovered, setDiscovered] = useState<string[] | null>(null);
  const [discoverError, setDiscoverError] = useState<string | null>(null);
  // Filters both the discovered list and the saved networks below. Big
  // bouncers (public BNC services) carry hundreds of networks, so scrolling
  // to find one isn't workable.
  const [search, setSearch] = useState('');

  const networks = bloc.bouncerNetworks();
  const connById = new Map(connections.map((c) => [c.serverId, c]));
  const haveNetwork = (n: string): boolean =>
    networks.some((s) => (s.bouncer?.network ?? '').toLowerCase() === n.toLowerCase());

  const needle = search.trim().toLowerCase();
  const matches = (...fields: (string | undefined)[]): boolean =>
    !needle || fields.some((f) => (f ?? '').toLowerCase().includes(needle));
  const visibleDiscovered = discovered?.filter((n) => matches(n)) ?? null;
  const visibleNetworks = networks.filter((s) => matches(s.name, s.bouncer?.network));
  const newDiscovered = visibleDiscovered?.filter((n) => !haveNetwork(n)) ?? [];
  const showSearch = (discovered?.length ?? 0) > 0 || networks.length > 0;

  // Two rows for one ZNC network would be two attaches to the same thing:
  // one's Disconnect network or closed channel hits the other too.
  const duplicate = (name.trim() !== '' || network.trim() !== '') && haveNetwork(network.trim());
  const add = (e: Event): void => {
    e.preventDefault();
    if ((!name.trim() && !network.trim()) || duplicate) return;
    bloc.addBouncerNetwork({ name, network });
    setName('');
    setNetwork('');
  };

  const pull = async (): Promise<void> => {
    setDiscovering(true);
    setDiscoverError(null);
    setDiscovered(null);
    try {
      setDiscovered(await bloc.discoverBouncerNetworks());
    } catch (err) {
      setDiscoverError(err instanceof Error ? err.message : 'Discovery failed.');
    } finally {
      setDiscovering(false);
    }
  };

  return (
    <div class="directory-bouncer">
      {profile?.enabled ? (
        <p class="directory-desc">
          Networks below connect through your bouncer at{' '}
          <span class="num">{profile.host}:{profile.port}</span>. Add one per ZNC network.
        </p>
      ) : (
        <WarningBanner tone="warn" title="No bouncer enabled">
          Set up your ZNC/BNC bouncer in <strong>User Settings → Bouncer</strong> first. Networks
          you add here connect through it.
        </WarningBanner>
      )}

      <form onSubmit={add} class="directory-bouncer-add">
        <Input
          value={name}
          onInput={(e) => setName((e.target as HTMLInputElement).value)}
          placeholder="Display name"
          autoComplete="off"
          spellcheck={false}
        />
        <Input
          value={network}
          onInput={(e) => setNetwork((e.target as HTMLInputElement).value)}
          placeholder="ZNC network, e.g. libera"
          autoComplete="off"
          spellcheck={false}
        />
        <Button type="submit" variant="secondary" disabled={(!name.trim() && !network.trim()) || duplicate}>
          Add network
        </Button>
      </form>
      {duplicate && (
        <WarningBanner tone="warn" title="Already added">
          {network.trim() ? <>The network <strong>{network.trim()}</strong> is</> : <>Your bouncer's default network is</>} already in your list below.
        </WarningBanner>
      )}

      {profile?.enabled && (
        <div class="directory-bouncer-discover">
          <Button variant="ghost" onClick={() => { void pull(); }} disabled={discovering}>
            {discovering ? 'Querying your bouncer…' : 'Pull from bouncer'}
          </Button>
          {discovering && <AtomLoader size={18} />}
        </div>
      )}

      {discoverError && (
        <WarningBanner tone="danger" title="Couldn't reach your bouncer">{discoverError}</WarningBanner>
      )}

      {showSearch && (
        <Input
          type="search"
          inputSize="sm"
          placeholder="Search networks…"
          value={search}
          onInput={(e) => setSearch((e.target as HTMLInputElement).value)}
          onKeyDown={(e) => { if (e.key === 'Escape' && search) { e.stopPropagation(); setSearch(''); } }}
          aria-label="Search networks"
          autoComplete="off"
          spellcheck={false}
        />
      )}

      {discovered && visibleDiscovered && (
        discovered.length === 0 ? (
          <EmptyState class="directory-empty">No networks found on your bouncer.</EmptyState>
        ) : (
          <div class="directory-bouncer-discovered">
            <div class="directory-bouncer-discovered-head">
              <span class="directory-hint">
                {needle
                  ? `Found on your bouncer: ${visibleDiscovered.length} of ${discovered.length}`
                  : 'Found on your bouncer:'}
              </span>
              {newDiscovered.length > 0 && (
                <Button
                  variant="secondary"
                  onClick={() => {
                    // While searching, only add what's on screen.
                    for (const n of newDiscovered) bloc.addBouncerNetwork({ name: n, network: n });
                  }}
                >
                  {needle ? `Add ${newDiscovered.length} matching` : 'Add all new'}
                </Button>
              )}
            </div>
            {visibleDiscovered.length === 0 && (
              <EmptyState class="directory-empty">No networks match “{search.trim()}”.</EmptyState>
            )}
            <div class="directory-bouncer-list" role="list">
              {visibleDiscovered.map((n) => (
                <ListRow
                  key={n}
                  class="directory-bouncer-row"
                  rowProps={{ role: 'listitem' }}
                  title={<span class="directory-bouncer-name">{n}</span>}
                  trailing={haveNetwork(n) ? (
                    <Badge tone="info">Added</Badge>
                  ) : (
                    <Button variant="primary" size="sm" onClick={() => bloc.addBouncerNetwork({ name: n, network: n })}>
                      Add
                    </Button>
                  )}
                />
              ))}
            </div>
          </div>
        )
      )}

      {networks.length === 0 ? (
        <EmptyState class="directory-empty">No bouncer networks yet — add one above.</EmptyState>
      ) : visibleNetworks.length === 0 ? (
        <EmptyState class="directory-empty">None of your networks match “{search.trim()}”.</EmptyState>
      ) : (
        <div class="directory-bouncer-list" role="list">
          {visibleNetworks.map((s) => {
            const conn = connById.get(s.id);
            return (
              <ListRow
                key={s.id}
                class="directory-bouncer-row"
                rowProps={{ role: 'listitem' }}
                title={<span class="directory-bouncer-name">{s.name}</span>}
                subtitle={`network: ${s.bouncer?.network ? s.bouncer.network : '(default)'}`}
                trailing={(
                  <>
                    <BouncerNetworkStatus
                      conn={conn}
                      onConnect={() => bloc.connectBouncerNetwork(s.id)}
                      onConnectUpstream={() => bloc.bouncerConnect(s.id)}
                    />
                    <Button variant="ghost" size="sm" onClick={() => bloc.removeBouncerNetwork(s.id)}>Remove</Button>
                  </>
                )}
              />
            );
          })}
        </div>
      )}
    </div>
  );
}

interface ServerCardProps {
  server: Server;
  engine: EngineClient | null;
  connected: boolean;
  isCurrent: boolean;
  myHandle: string | undefined;
  onConnect: () => void;
  // Opens the server's details (a click on the card).
  onOpen: () => void;
  // Added by address (stored on this device): a LOCAL chip, its address,
  // and Remove.
  isLocal?: boolean;
  onRemove?: () => void;
  // Name the directory that lists it (when it isn't the default).
  showSource?: boolean;
}

// One card per server: avatar, name and status; description and tags;
// people online and Connect. A click anywhere but its buttons opens the
// server's details. The address (host:port) is a detail, not a headline —
// only a server you added by address shows it, as that's how you know it.
//
// Self-contained block; the parent renders these inside a CSS grid that
// auto-flows from 3 → 2 → 1 columns based on viewport width.
function ServerCard({
  server, engine, connected, isCurrent, myHandle, onConnect, onOpen,
  isLocal, onRemove, showSource,
}: ServerCardProps) {
  const isOffline = server.health_status === 'down';
  const verified = server.verification_status === 'verified';
  const userCount = typeof server.user_count === 'number' ? server.user_count : null;
  const joins = joinsLabel(server.autojoin_channels);

  return (
    <article
      class="directory-card"
      role="listitem"
      onClick={(e) => {
        if ((e.target as Element | null)?.closest?.('button, a, input')) return;
        onOpen();
      }}
    >
      <header class="directory-card-head">
        <ServerAvatar server={server} size={44} />
        <div class="directory-card-titles">
          <h3 class="directory-card-name">
            <button type="button" class="directory-card-open" onClick={onOpen} aria-label={`${server.name}: details`}>
              {server.name}
            </button>
            <span class={`directory-card-status ${isOffline ? 'directory-card-status-offline' : ''}`}>
              <StatusDot status={isOffline ? 'offline' : 'online'} />
              {isOffline ? 'OFFLINE' : 'ONLINE'}
            </span>
          </h3>
          {isLocal && <div class="directory-card-host">{serverAddress(server)}</div>}
        </div>
      </header>

      <div class="directory-card-body">
        {server.description && (
          <p class="directory-card-desc">{server.description}</p>
        )}
        {(server.tags.length > 0 || isLocal || verified || (showSource && server.source)) && (
          <div class="directory-card-tags">
            {isLocal && <Badge tone="warn" class="directory-card-tag directory-card-tag-local">LOCAL</Badge>}
            {verified && <Badge tone="verified" class="directory-card-tag directory-card-tag-verified">VERIFIED</Badge>}
            {showSource && server.source && (
              <Badge
                tone="neutral"
                class="directory-card-tag directory-card-tag-source"
                title={server.also_listed_on?.length
                  ? `Listed on ${server.source.name}, and on ${server.also_listed_on.join(', ')}`
                  : `Listed on ${server.source.name}`}
              >
                {server.source.name}{server.also_listed_on?.length ? ` +${server.also_listed_on.length}` : ''}
              </Badge>
            )}
            {server.tags.map((t) => (
              <Badge key={t} tone="neutral" class="directory-card-tag">{t.toUpperCase()}</Badge>
            ))}
          </div>
        )}
        <div class="directory-card-meta">
          {userCount !== null && (
            <span class="directory-card-count">
              <span class="directory-card-count-icon" aria-hidden="true">👥</span>
              {userCount.toLocaleString()} {userCount === 1 ? 'user' : 'users'}
            </span>
          )}
          {joins && (
            <span class="directory-card-joins" title={`New members join ${(server.autojoin_channels ?? []).join(', ')}`}>
              {joins}
            </span>
          )}
          {isCurrent && (
            <Badge tone="success" class="directory-current-badge" title="You're connected to this server">
              CURRENTLY CONNECTED
            </Badge>
          )}
        </div>
      </div>

      <footer class="directory-card-footer">
        {isLocal && onRemove && (
          <Button
            variant="ghost"
            size="sm"
            tone="danger"
            class="directory-local-remove"
            onClick={onRemove}
            title="Remove this server from this device"
          >
            Remove
          </Button>
        )}
        {engine && (
          connected ? (
            <Badge tone="neutral" class="directory-list-joined">Joined</Badge>
          ) : (
            <Button
              variant="primary"
              size="sm"
              onClick={onConnect}
              disabled={!myHandle || isOffline}
              title={isOffline ? 'This server is offline right now' : myHandle ? `Connect as ${myHandle}` : 'Set up your handle first'}
            >
              Connect
            </Button>
          )
        )}
      </footer>
    </article>
  );
}

function serverAddress(server: Pick<Server, 'hostname' | 'port' | 'tls'>): string {
  return `${server.hostname}:${server.port}${server.tls ? ' (TLS)' : ''}`;
}

function ServerAvatar({ server, size }: { server: Server; size: number }) {
  return (
    <Avatar
      size={size}
      class="directory-card-avatar"
      initial={computeInitials(server.name || server.hostname)}
      color={`hsl(${hashHue(server.name || server.hostname)} 70% 50%)`}
      image={server.icon_url ? <img src={server.icon_url} alt="" loading="lazy" /> : undefined}
    />
  );
}

// How many of the network's channels the details list.
const DETAIL_CHANNELS = 8;

// A server's details (a click on its card): what it is, its channels (each
// one joins on connect), how many people are on, and Connect — which an
// offline server doesn't offer.
export function ServerDetails({ server, connected, canConnect, onConnect, onClose }: {
  server: Server | null;
  connected: boolean;
  canConnect: boolean;
  onConnect: (server: Server, join?: string) => void;
  onClose: () => void;
}) {
  // Keep the last server on screen while the dialog animates closed.
  const last = useRef<Server | null>(null);
  if (server) last.current = server;
  const s = server ?? last.current;
  if (!s) return null;
  const isOffline = s.health_status === 'down';
  const userCount = typeof s.user_count === 'number' ? s.user_count : null;
  const autojoin = new Set((s.autojoin_channels ?? []).map((c) => c.toLowerCase()));
  // The network's own channels, its default ones first.
  const channels = [...new Set([...(s.autojoin_channels ?? []), ...(s.channels ?? [])])].slice(0, DETAIL_CHANNELS);
  const joinable = canConnect && !isOffline && !connected;
  return (
    <Modal open={!!server} onClose={onClose} title={s.name}>
      <div class="directory-details">
        <div class="directory-details-head">
          <ServerAvatar server={s} size={56} />
          <div class="directory-details-titles">
            <span class={`directory-card-status ${isOffline ? 'directory-card-status-offline' : ''}`}>
              <StatusDot status={isOffline ? 'offline' : 'online'} />
              {isOffline ? 'OFFLINE' : 'ONLINE'}
            </span>
            {userCount !== null && (
              <span class="directory-details-count">
                {userCount.toLocaleString()} {userCount === 1 ? 'person' : 'people'} online
              </span>
            )}
          </div>
        </div>
        {s.description
          ? <p class="directory-details-desc">{s.description}</p>
          : <p class="directory-details-desc directory-details-muted">No description yet.</p>}
        {s.tags.length > 0 && (
          <div class="directory-card-tags">
            {s.tags.map((t) => <Badge key={t} tone="neutral" class="directory-card-tag">{t.toUpperCase()}</Badge>)}
          </div>
        )}
        {channels.length > 0 && (
          <section class="directory-details-section" aria-label="Channels">
            <h4 class="directory-details-heading">Channels</h4>
            <div class="directory-details-channels" role="list">
              {channels.map((c) => (
                <ListRow
                  key={c}
                  class="directory-details-channel"
                  rowProps={{ role: 'listitem' }}
                  title={c}
                  subtitle={autojoin.has(c.toLowerCase()) ? 'Everyone starts here' : undefined}
                  trailing={joinable ? (
                    <Button variant="secondary" size="sm" onClick={() => onConnect(s, c)} aria-label={`Join ${c}`}>Join</Button>
                  ) : undefined}
                />
              ))}
            </div>
          </section>
        )}
        <dl class="directory-details-facts">
          {s.website_url && (
            <>
              <dt>Website</dt>
              <dd><a href={s.website_url} target="_blank" rel="noopener noreferrer">{s.website_url.replace(/^https?:\/\//, '')}</a></dd>
            </>
          )}
          <dt>Address</dt>
          <dd class="directory-details-address">{serverAddress(s)}</dd>
        </dl>
        <div class="directory-details-actions">
          {connected ? (
            <Badge tone="neutral" class="directory-list-joined">Joined</Badge>
          ) : (
            <Button
              variant="primary"
              onClick={() => onConnect(s)}
              disabled={!joinable}
              title={isOffline ? 'This server is offline right now' : undefined}
            >
              {isOffline ? 'Offline' : 'Connect'}
            </Button>
          )}
        </div>
      </div>
    </Modal>
  );
}

// Two-letter initials from the first two whitespace/punctuation-separated
// tokens of the server name; falls back to the first two characters.
// Builds the optional `directoryEntry` + `onSaveProfile` props for
// <ServerSettings>. Returns an empty object when the row isn't a full
// directory Server (cold-start SavedServer has no profile fields) or
// when the signed-in user isn't the row's owner. Extracted from the
// JSX call site purely for readability — the inline ternary version
// got long enough that the surrounding component was hard to scan.
export function buildEditableProps(
  connServer: import('../../modules/directory').Server | import('../../modules/session').SavedServer,
  me: import('../../modules/directory').User | null | undefined,
  bloc: DirectoryBloc,
  directory: import('../../modules/directory').Server[] | null,
  // The bloc's remembered/looked-up listing for this connection, if any.
  listing?: import('../../modules/directory').Server,
): {
  directoryEntry?: import('../ChatLayout/ServerSettings').DirectoryEntryProfile;
  onSaveProfile?: (
    patch: Partial<import('../ChatLayout/ServerSettings').DirectoryEntryProfile>,
  ) => Promise<void>;
  onSaveServerImage?: (kind: 'icon' | 'banner', image: Blob | null) => Promise<void>;
} {
  // The connection may hold either a full directory `Server` (when opened
  // from the listing) or a `SavedServer` cold-start snapshot (restored on
  // app start), which carries only hostname/port/tls/name/id — no profile
  // fields, no `registered_by`. An owner reconnecting from a saved session
  // would otherwise never see their Edit tab, so when the connection lacks
  // the profile fields we resolve the full row from the loaded directory
  // list — by id, legacy id or address (findListing): a session saved before
  // the /v1 directory keys the server by its legacy uuid. The loaded row
  // wins over the connection's own snapshot (it carries `owned` and the
  // listing's current id, which owner calls need).
  const server = findListing(connServer, directory)
    ?? listing
    ?? ('tags' in connServer ? connServer : undefined);
  if (!server) return {};
  if (!me?.id || me.id === '__guest__') return {};
  // Owned: /v1/me/networks on its directory listed it, or (legacy rows)
  // the boson API recorded us as the registrant.
  if (!server.owned && server.registered_by !== me.id) return {};
  return {
    directoryEntry: {
      serverId: server.id,
      name: server.name,
      description: server.description ?? '',
      tags: server.tags ?? [],
      languages: server.languages ?? [],
      isNsfw: server.is_nsfw ?? false,
      iconUrl: server.icon_url,
      bannerUrl: server.banner_url,
    },
    onSaveProfile: (patch) => bloc.updateServerProfile(server.id, patch),
    onSaveServerImage: (kind, image) => bloc.setServerImage(server.id, kind, image),
  };
}

// Resolve a connection's owner-set icon/banner CDN URLs. Like the Edit-tab
// gate, the connection may hold a full directory `Server` (carries the URLs)
// or a cold-start `SavedServer` snapshot (doesn't) — in the latter case we
// look the full row up in the loaded directory list (by id, legacy id or
// address — see findListing), then the bloc's remembered listing. Both URLs are
// undefined when unresolved or unset, which the consumers fall back from
// (initials tile / plain sidebar header).
export function resolveServerImages(
  conn: import('./DirectoryBloc').DirectoryConnection,
  directory: import('../../modules/directory').Server[] | null,
  listing?: import('../../modules/directory').Server,
): { iconUrl?: string; bannerUrl?: string } {
  const full = resolveListing(conn, directory, listing);
  return { iconUrl: full?.icon_url, bannerUrl: full?.banner_url };
}

// The directory listing a connection is (see resolveServerImages).
export function resolveListing(
  conn: import('./DirectoryBloc').DirectoryConnection,
  directory: import('../../modules/directory').Server[] | null,
  listing?: import('../../modules/directory').Server,
): import('../../modules/directory').Server | undefined {
  return findListing(conn.server, directory)
    ?? listing
    ?? ('tags' in conn.server ? conn.server : undefined);
}

function computeInitials(name: string): string {
  const cleaned = name.trim();
  if (!cleaned) return '??';
  const parts = cleaned.split(/[\s.\-_]+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0]![0]! + parts[1]![0]!).toUpperCase();
  return cleaned.slice(0, 2).toUpperCase();
}

// Deterministic hue (0–360) from the input string. Same name → same color
// across renders / sessions. Saturation + lightness are fixed at the call
// site to keep the palette consistent.
function hashHue(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (h * 31 + s.charCodeAt(i)) | 0;
  }
  return Math.abs(h) % 360;
}

// "Add by address" form. Local-only — never sent to the
// Boson directory backend. Sensible defaults: TLS on, port 6697. Submitting
// adds it to the merged directory list immediately; the connection itself
// still uses the regular Connect button.
interface AddLocalServerFormProps {
  onSubmit: (input: {
    name: string;
    hostname: string;
    port: number;
    tls: boolean;
    tlsInsecure?: boolean;
    serverPass?: string;
    sasl?: { user: string; password: string };
    nickservPassword?: string;
  }) => void;
  onCancel: () => void;
  initialHostname?: string;
}

function AddLocalServerForm({ onSubmit, onCancel, initialHostname = '' }: AddLocalServerFormProps) {
  const [name, setName] = useState('');
  const [hostname, setHostname] = useState(initialHostname);
  const [port, setPort] = useState('6697');
  const [tls, setTls] = useState(true);
  const [tlsInsecure, setTlsInsecure] = useState(false);
  const [serverPass, setServerPass] = useState('');
  const [saslUser, setSaslUser] = useState('');
  const [saslPass, setSaslPass] = useState('');
  const [nickservPass, setNickservPass] = useState('');
  const [err, setErr] = useState<string | null>(null);

  const submit = (e: Event): void => {
    e.preventDefault();
    const trimmedHost = hostname.trim();
    const trimmedName = name.trim() || trimmedHost;
    const portNum = Number.parseInt(port, 10);
    if (!trimmedHost) { setErr('Hostname is required.'); return; }
    if (!Number.isFinite(portNum) || portNum < 1 || portNum > 65535) {
      setErr('Port must be a number between 1 and 65535.');
      return;
    }
    // SASL needs both halves to be usable — reject a half-filled pair rather
    // than silently sending an empty account/password to the daemon.
    const saslAccount = saslUser.trim();
    if ((saslAccount && !saslPass) || (!saslAccount && saslPass)) {
      setErr('SASL needs both an account and a password (or leave both blank).');
      return;
    }
    onSubmit({
      name: trimmedName,
      hostname: trimmedHost,
      port: portNum,
      tls,
      // Skipping verification only means anything for a TLS connection.
      tlsInsecure: tls ? tlsInsecure : false,
      serverPass: serverPass || undefined,
      sasl: saslAccount && saslPass ? { user: saslAccount, password: saslPass } : undefined,
      nickservPassword: nickservPass || undefined,
    });
  };

  // TLS on/off moves the port between the usual two, unless it was set to
  // something else.
  const setTlsAndPort = (on: boolean): void => {
    setTls(on);
    setPort((p) => (on && p.trim() === '6667' ? '6697' : !on && p.trim() === '6697' ? '6667' : p));
  };
  // Everything past host, port and name: open when it holds something (a
  // validation error there, or a plain-text connection).
  const [more, setMore] = useState(false);
  const moreOpen = more || !!(err && err.toLowerCase().includes('sasl'));

  return (
    <form class="directory-add-form" onSubmit={submit}>
      <p class="directory-hint">Connect to any IRC server, listed or not. It's saved on this device only.</p>
      <Field
        label="Hostname"
        hint="e.g. irc.example.org or 192.168.1.42 — local-network addresses work."
        error={err && err.toLowerCase().includes('host') ? err : undefined}
      >
        <Input
          placeholder="irc.example.org"
          value={hostname}
          onInput={(e) => setHostname((e.target as HTMLInputElement).value)}
          autoFocus
          required
          autoComplete="off"
          spellcheck={false}
        />
      </Field>

      <div class="directory-add-form-row">
        <Field
          label="Port"
          hint={tls ? 'Usually 6697 (TLS).' : 'Usually 6667 (no TLS).'}
          error={err && err.toLowerCase().includes('port') ? err : undefined}
        >
          <Input
            value={port}
            onInput={(e) => setPort((e.target as HTMLInputElement).value)}
            autoComplete="off"
            spellcheck={false}
            inputMode="numeric"
          />
        </Field>
        <Field label="Display name" hint="Defaults to the hostname.">
          <Input
            placeholder={hostname || 'My server'}
            value={name}
            onInput={(e) => setName((e.target as HTMLInputElement).value)}
            autoComplete="off"
            spellcheck={false}
          />
        </Field>
      </div>

      <Button
        type="button"
        variant="ghost"
        size="sm"
        class="directory-add-more"
        aria-expanded={moreOpen}
        onClick={() => setMore((v) => !v)}
      >
        {moreOpen ? '▾' : '▸'} More options
      </Button>

      {moreOpen && (
        <div class="directory-add-more-body">
          <Toggle checked={tls} onChange={setTlsAndPort} label="Use TLS (recommended)" />

          {tls && (
            <Toggle
              checked={tlsInsecure}
              onChange={setTlsInsecure}
              label="Skip certificate verification (self-signed certs)"
            />
          )}

          <Field
            label="Server password"
            hint="Optional. Sent as the IRC PASS line — for private daemons or a bouncer."
          >
            <Input
              type="password"
              placeholder="••••••••"
              value={serverPass}
              onInput={(e) => setServerPass((e.target as HTMLInputElement).value)}
              autoComplete="off"
              spellcheck={false}
            />
          </Field>

          <div class="directory-add-form-row">
            <Field
              label="SASL account"
              hint="Optional SASL PLAIN login."
              error={err && err.toLowerCase().includes('sasl') ? err : undefined}
            >
              <Input
                placeholder="account"
                value={saslUser}
                onInput={(e) => setSaslUser((e.target as HTMLInputElement).value)}
                autoComplete="off"
                spellcheck={false}
              />
            </Field>
            <Field label="SASL password" hint="Paired with the SASL account.">
              <Input
                type="password"
                placeholder="••••••••"
                value={saslPass}
                onInput={(e) => setSaslPass((e.target as HTMLInputElement).value)}
                autoComplete="off"
                spellcheck={false}
              />
            </Field>
          </div>

          <Field
            label="NickServ password"
            hint="Optional. Auto-identifies to NickServ after connecting. Editable later in Services."
          >
            <Input
              type="password"
              placeholder="••••••••"
              value={nickservPass}
              onInput={(e) => setNickservPass((e.target as HTMLInputElement).value)}
              autoComplete="off"
              spellcheck={false}
            />
          </Field>
        </div>
      )}

      <div class="directory-add-actions">
        <Button type="button" variant="ghost" onClick={onCancel}>Cancel</Button>
        <Button type="submit" variant="primary">Add server</Button>
      </div>
    </form>
  );
}

interface SetupPromptProps {
  directory: DirectoryService;
  identity: IdentityService;
  onDone: (user: User) => void;
}

// The API's refusals, in the form's words (the same as Settings').
export function describeHandleError(err: unknown): string {
  if (err instanceof HttpError) {
    if (err.status === 409) return 'That handle is taken — pick another.';
    if (err.status === 400) return /3 characters/.test(err.message) ? 'Handle must be at least 3 characters.' : sentence(err.message);
  }
  return err instanceof Error ? sentence(err.message) : 'Setup failed. Try again.';
}

function SetupPrompt({ directory, identity, onDone }: SetupPromptProps) {
  const auth = useAuthService();
  const { session } = useAuthState();
  // One name: the handle starts as the username picked at sign-up.
  const [handle, setHandle] = useState(session?.user.username ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The identity's password wrap is made at sign-in and kept in memory until
  // this step posts it. After a reload it's gone (the key itself comes back
  // from this device's store), so the password is asked for again here and
  // the wraps are made afresh, instead of failing.
  const [needsPassword, setNeedsPassword] = useState(() => !identity.getPendingEncrypted());
  const [password, setPassword] = useState('');
  const [passwordError, setPasswordError] = useState<string | null>(null);
  // After account creation we hold the created user + the one-time recovery
  // code, and switch to the recovery-code view before finishing. onDone is
  // gated behind the user acknowledging they've saved the code.
  const [created, setCreated] = useState<User | null>(null);
  const [recoveryCode, setRecoveryCode] = useState<string | null>(null);
  const userId = session?.user.id ?? '';

  // Re-make the wraps with the password, once it's checked with the auth
  // service (a wrong one would lock the key on the next sign-in).
  const wrapsFromPassword = async (): Promise<{ encrypted: string; recoveryBlob?: string; recoveryCode?: string } | null> => {
    const login = session?.user.email || session?.user.username;
    if (!login) throw new Error('Sign in again to finish setting up.');
    try {
      await auth.signIn(login, password);
    } catch (err) {
      setPasswordError(err instanceof AuthError && err.code === 'invalid_credentials' ? "That password isn't right." : describeAuthError(err));
      return null;
    }
    if (identity.isUnlocked()) {
      const encrypted = await identity.rewrapForNewPassword(password);
      const recovery = await identity.enrollRecoveryCode();
      return { encrypted, recoveryBlob: recovery.recoveryBlob, recoveryCode: recovery.recoveryCode };
    }
    const encrypted = await identity.initializeForNewUser(password);
    const recovery = identity.getPendingRecovery();
    return { encrypted, recoveryBlob: recovery?.recoveryBlob, recoveryCode: recovery?.recoveryCode };
  };

  const submit = async (e: Event) => {
    e.preventDefault();
    const name = handle.trim();
    const problem = validateHandle(name);
    if (problem) { setError(problem); return; }
    setBusy(true);
    setError(null);
    setPasswordError(null);
    try {
      let encrypted = identity.getPendingEncrypted();
      let recovery = identity.getPendingRecovery();
      if (!encrypted) {
        if (!password) {
          setNeedsPassword(true);
          setPasswordError('Enter your password to finish.');
          return;
        }
        const wraps = await wrapsFromPassword();
        if (!wraps) return;
        encrypted = wraps.encrypted;
        recovery = wraps.recoveryBlob && wraps.recoveryCode
          ? { recoveryBlob: wraps.recoveryBlob, recoveryCode: wraps.recoveryCode }
          : null;
      }
      // Store the recovery wrap alongside the password wrap at account
      // creation so the user has a recovery path from day one.
      const user = await directory.setupMe(name, encrypted, recovery?.recoveryBlob);
      const code = recovery?.recoveryCode ?? null;
      identity.clearPendingEncrypted();
      if (userId) void identity.persist(userId);
      if (code) {
        // Show the code once, then finish. Until it's confirmed, a reload
        // comes back to this step (with a new code).
        markRecoveryPending(userId);
        setCreated(user);
        setRecoveryCode(code);
      } else {
        onDone(user);
      }
    } catch (err) {
      setError(describeHandleError(err));
    } finally {
      setBusy(false);
    }
  };

  if (recoveryCode && created) {
    return (
      <RecoveryCodeReveal
        code={recoveryCode}
        intro="Save your recovery code. If you ever reset your password, you'll need it once to get your synced passwords back. We can't recover it for you."
        onContinue={() => { clearRecoveryPending(userId); onDone(created); }}
      />
    );
  }

  const nameProblem = handle.trim() ? validateHandle(handle.trim()) : null;
  return (
    <form class="directory-setup-prompt" onSubmit={submit}>
      <div class="directory-setup-header">
        <h2>Finish setting up your account</h2>
        <p>Choose your handle: how people find you on Boson, and your name in chat.</p>
      </div>
      <Field
        label="Handle"
        hint="Starts as your username. Use 3–30 letters, digits, - or _, starting with a letter. You can rename it later; your old handle keeps finding you for 90 days."
        error={error ?? (handle.trim().length >= 3 ? nameProblem ?? undefined : undefined)}
      >
        <Input
          placeholder="handle"
          value={handle}
          onInput={(e) => { setHandle((e.target as HTMLInputElement).value); setError(null); }}
          invalid={!!error}
          required
          autoComplete="off"
          spellcheck={false}
        />
      </Field>
      {needsPassword && (
        <>
          <p class="setup-password-note">The page reloaded during setup. Enter your password once more to finish.</p>
          <Field label="Password" error={passwordError ?? undefined}>
            <Input
              type="password"
              placeholder="password"
              value={password}
              onInput={(e) => { setPassword((e.target as HTMLInputElement).value); setPasswordError(null); }}
              invalid={!!passwordError}
              autoComplete="current-password"
            />
          </Field>
        </>
      )}
      <Button type="submit" variant="primary" loading={busy} disabled={busy || handle.trim().length < 3 || (needsPassword && !password)}>
        Save
      </Button>
    </form>
  );
}

// Sign-up was interrupted on the recovery-code step (a reload): the code
// that was shown is gone, so make a new one, store its wrap, and show it.
function RecoveryResume({ directory, identity, onDone }: {
  directory: DirectoryService;
  identity: IdentityService;
  onDone: () => void;
}) {
  const [code, setCode] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const r = await identity.enrollRecoveryCode();
        await directory.updateSecretWraps({ recoveryBlob: r.recoveryBlob });
        if (live) setCode(r.recoveryCode);
      } catch (err) {
        if (live) setError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => { live = false; };
  }, [directory, identity]);
  if (error) {
    return (
      <div class="directory-setup-prompt">
        <div class="directory-setup-header">
          <h2>Your recovery code</h2>
          <p>Couldn't make your recovery code ({error}). You can make one any time in Settings → Account.</p>
        </div>
        <Button variant="primary" onClick={onDone}>Continue</Button>
      </div>
    );
  }
  if (!code) return <div class="directory-setup-prompt"><BarLoader label="Making your recovery code" /></div>;
  return (
    <RecoveryCodeReveal
      code={code}
      intro="Setup was interrupted before you saved your recovery code, so here's a new one (the earlier code no longer works). If you ever reset your password, you'll need it once to get your synced passwords back."
      onContinue={onDone}
    />
  );
}

