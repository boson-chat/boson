import { useEffect, useMemo, useState } from 'preact/hooks';
import { useAuthService, useAuthState } from '../../modules/auth';
import type { DirectoryService } from '../../modules/directory';
import type { Server, User } from '../../modules/directory';
import { subscribeDeepLink } from '../../modules/deep-link/deep-link';
import type { EngineClient, EngineState } from '../../modules/engine';
import type { ChatHistoryStore } from '../../modules/history';
import type { IdentityService } from '../../modules/identity';
import { RecoveryCodeReveal } from '../../components/RecoveryCodeReveal';
import { ChatLayout } from '../ChatLayout';
import { ServerRail } from '../ChatLayout/ServerRail';
import { ServerSettings } from '../ChatLayout/ServerSettings';
import { AtomLoader, Button, Field, Input, Modal, Toggle, WarningBanner } from '@boson/shared';
import { DirectoryBloc, type DirectoryState, activeConnection, aggregateEngineState } from './DirectoryBloc';
import { HostServerModal } from './HostServerModal';
import './DirectoryScreen.css';

interface Props {
  directory: DirectoryService;
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

export function DirectoryScreen({ directory, engine, identity, history, guestNick }: Props) {
  const auth = useAuthService();
  const authState = useAuthState();

  // guestNick is intentionally NOT in the dep array: flipping between guest
  // and account modes feeds in through `bloc.setIdentity()` below so the
  // same bloc instance survives the transition. Recreating the bloc would
  // tear down all ChatServices + state subscriptions, leaving the live
  // engine sessions orphaned and the user staring at a stuck-connecting UI.
  const bloc = useMemo(
    () => new DirectoryBloc({
      auth,
      directory,
      identity,
      engine,
      history,
      guestNick,
      // Use a function so the bloc reads the live userId at the moment it
      // constructs the ChatService. In guest mode no Supabase session
      // exists; ChatService falls back to its in-memory log behaviour.
      getUserId: () => auth.getState().session?.user?.id ?? null,
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- guestNick is
    // propagated via setIdentity, not by recreating the bloc.
    [auth, directory, identity, engine, history],
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

  const [state, setState] = useState<DirectoryState>(() => bloc.getState());
  useEffect(() => bloc.subscribe(setState), [bloc]);

  // Full-page Server settings overlay — populated when the user right-clicks
  // a server-rail tile and picks "Server details". Null otherwise; we render
  // the normal chat layout. The id is the connection's serverId.
  const [serverSettingsForId, setServerSettingsForId] = useState<string | null>(null);

  const { me, showChat, restoring, serverBrowserOpen, connections, activeServerId } = state;
  const active = activeConnection(state);
  const aggState = aggregateEngineState(state);

  // If the user opens server-settings, replace the channel sidebar + chat
  // area + user panel with the settings page. The server rail stays so the
  // user can switch servers (which closes settings) or open settings for a
  // different server via right-click.
  if (serverSettingsForId !== null) {
    const target = connections.find((c) => c.serverId === serverSettingsForId);
    if (!target || !me?.handle) {
      setServerSettingsForId(null);
    } else {
      const chatState = target.chat.getState();
      return (
        <div class="app-shell">
          <ServerRail
            servers={connections.map((c) => {
              const chs = c.chat.getState().channels;
              let unread = 0;
              let mentions = 0;
              for (const ch of chs) { unread += ch.unread; mentions += ch.mentions; }
              return {
                serverId: c.serverId,
                name: c.server.name,
                engineState: c.engineState,
                unread,
                mentions,
              };
            })}
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
          />
          <ServerSettings
            serverDisplayName={target.server.name}
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
            signedIn={Boolean(me)}
            // Ownership check: render the Edit tab only when (a) the
            // current connection knows the full directory Server (not
            // a cold-start SavedServer snapshot which lacks profile
            // fields), and (b) the signed-in account owns that row.
            // Both branches short-circuit to plain ServerSettings —
            // the tab simply doesn't appear in the menu.
            {...buildEditableProps(target.server, me, bloc)}
          />
        </div>
      );
    }
  }

  if (showChat && active && me?.handle) {
    return (
      <>
        <ChatLayout
          chat={active.chat}
          serverName={active.server.name}
          myNick={me.handle}
          servers={connections.map((c) => {
            // Aggregate unread + mention counts across every channel in this
            // server, so the rail badge reflects total activity at a glance.
            // chat.getState() is cheap here — it's already memoized snapshots.
            const chs = c.chat.getState().channels;
            let unread = 0;
            let mentions = 0;
            for (const ch of chs) { unread += ch.unread; mentions += ch.mentions; }
            return {
              serverId: c.serverId,
              name: c.server.name,
              engineState: c.engineState,
              unread,
              mentions,
            };
          })}
          activeServerId={activeServerId}
          onSelectServer={(id) => bloc.setActiveServer(id)}
          onBrowseServers={() => bloc.openServerBrowser()}
          engineState={active.engineState}
          onReconnect={() => { void bloc.reconnectActive(); }}
          onCancelReconnect={() => bloc.cancelReconnectActive()}
          reconnectActive={active.reconnect.active}
          connectionError={active.error}
          onOpenServerSettings={(id) => setServerSettingsForId(id)}
          onLeaveServer={(id) => bloc.disconnect(id)}
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

  const displayHandle = me?.handle ? `@${me.handle}` : authState.session?.user.email ?? '';

  return (
    <div class="directory-screen">
      <header class="directory-topbar">
        <div class="directory-topbar-left">
          {engine && (
            <EnginePill
              state={aggState}
              connectionsCount={connections.length}
              connectedCount={connections.filter((c) => c.engineState === 'connected').length}
              connected={aggState === 'connected'}
              onOpenChat={() => bloc.openChat()}
            />
          )}
        </div>
        <div class="directory-topbar-right">
          <span class="directory-handle">{displayHandle}</span>
          <Button variant="ghost" onClick={() => { void bloc.signOut(); }}>Sign out</Button>
        </div>
      </header>

      <div class="directory-container">
        <DirectoryBody
          bloc={bloc}
          state={state}
          engine={engine}
          directory={directory}
          identity={identity}
        />
      </div>
    </div>
  );
}

interface DirectoryBodyProps {
  bloc: DirectoryBloc;
  state: DirectoryState;
  engine: EngineClient | null;
  directory: DirectoryService;
  identity: IdentityService;
}

// Renders the search + filters + server list. Shared between the standalone
// directory screen and the modal overlay variant so the two views stay in
// lockstep (no risk of drift between "browsing for the first time" and
// "browsing to switch servers mid-chat").
function DirectoryBody({ bloc, state, engine, directory, identity }: DirectoryBodyProps) {
  const {
    me, servers, filteredServers, query, language, showNsfw, error, connections,
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
  // Advanced mode — toggleable in-place, gives access to the manual server
  // add form + per-row remove on local entries. Local-only (not persisted)
  // because it's purely a UI affordance.
  const [advanced, setAdvanced] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [hostOpen, setHostOpen] = useState(false);
  return (
    <>
      {error && (
        <WarningBanner tone="danger" title="Couldn't load directory">{error}</WarningBanner>
      )}

      <div class="directory-header">
        <div class="directory-prompt">$ boson dir --list</div>
        <div class="directory-header-row">
          <h1 class="directory-title">Server Directory</h1>
          {/* "Add your server" CTA is only shown to authenticated users —
             guest users have no row in /me so registering would 401.
             For them the Advanced toggle's manual-add path is still
             available. */}
          <div class="directory-header-actions">
            <Button
              variant="ghost"
              onClick={() => bloc.refreshDirectory()}
              title="Refetch the directory from the backend"
            >
              Refresh
            </Button>
            {me && (
              <Button variant="secondary" onClick={() => setHostOpen(true)}>
                Add your server to the community
              </Button>
            )}
          </div>
        </div>
        <p class="directory-desc">
          Discover and join self-hosted IRC servers. Browse, search, and find communities that match your interests.
        </p>
      </div>

      <div class="directory-filters">
        <input
          type="text"
          class="directory-search"
          placeholder="Search servers…"
          value={query}
          onInput={(e) => bloc.setQuery((e.target as HTMLInputElement).value)}
          aria-label="Search servers"
        />

        <div class="directory-lang-chips" role="tablist" aria-label="Filter by language">
          {LANGUAGE_FILTERS.map((f) => (
            <button
              key={f.id}
              type="button"
              role="tab"
              aria-selected={language === f.id}
              class={`filter-chip ${language === f.id ? 'filter-chip-active' : ''}`}
              onClick={() => bloc.setLanguage(f.id)}
            >
              {f.label}
            </button>
          ))}
        </div>

        <Toggle checked={showNsfw} onChange={(v) => bloc.setShowNsfw(v)} label="Show NSFW" />

        <button
          type="button"
          class={`directory-advanced-toggle ${advanced ? 'directory-advanced-toggle-active' : ''}`}
          onClick={() => setAdvanced((v) => !v)}
          title="Show advanced controls (add a server manually)"
        >
          Advanced
        </button>
      </div>

      {advanced && (
        <div class="directory-advanced-actions">
          <Button variant="secondary" onClick={() => setAddOpen(true)}>
            + Add server manually
          </Button>
          <span class="directory-list-tag" style="text-transform: none;">
            Local entries are stored on this device only — never published to the directory.
          </span>
        </div>
      )}

      <Modal open={addOpen} onClose={() => setAddOpen(false)} title="Add a server manually">
        <AddLocalServerForm
          onSubmit={(input) => {
            bloc.addLocalServer(input);
            setAddOpen(false);
          }}
          onCancel={() => setAddOpen(false)}
        />
      </Modal>

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
      />

      {filteredServers === null ? (
        <div class="directory-loading">
          <AtomLoader size={32} />
          <span>Loading directory…</span>
        </div>
      ) : filteredServers.length === 0 ? (
        <div class="directory-empty">{servers && servers.length > 0 ? 'No servers match these filters.' : 'No servers found.'}</div>
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
                onConnect={() => { void bloc.connect(s); }}
                isLocal={isLocal}
                showRemove={advanced && isLocal}
                onRemove={() => bloc.removeLocalServer(s.id)}
              />
            );
          })}
        </div>
      )}
    </>
  );
}

interface ServerCardProps {
  server: Server;
  engine: EngineClient | null;
  connected: boolean;
  isCurrent: boolean;
  myHandle: string | undefined;
  onConnect: () => void;
  // Locally-added (advanced mode) — rendered with a 'LOCAL' chip + Remove
  // button when `showRemove` is true.
  isLocal?: boolean;
  showRemove?: boolean;
  onRemove?: () => void;
}

// One card per server. Layout mirrors the 03-directory.png mockup:
//   - top: avatar (initials, deterministic hue) + name/online + host
//   - body: description, tags
//   - footer: user count / verified date + Connect/Joined/Remove
//
// Self-contained block; the parent renders these inside a CSS grid that
// auto-flows from 3 → 2 → 1 columns based on viewport width.
function ServerCard({
  server, engine, connected, isCurrent, myHandle, onConnect,
  isLocal, showRemove, onRemove,
}: ServerCardProps) {
  const isOffline = server.health_status === 'down';
  const verified = server.verification_status === 'verified';
  const userCount = typeof server.user_count === 'number' ? server.user_count : null;
  const initials = computeInitials(server.name || server.hostname);
  const hue = hashHue(server.name || server.hostname);
  const avatarStyle = `background: hsl(${hue} 70% 50%); color: #070709;`;

  return (
    <article class="directory-card" role="listitem">
      <header class="directory-card-head">
        <div class="directory-card-avatar" style={avatarStyle} aria-hidden="true">
          {initials}
        </div>
        <div class="directory-card-titles">
          <h3 class="directory-card-name">
            {server.name}
            <span class={`directory-card-status ${isOffline ? 'directory-card-status-offline' : ''}`}>
              <span class="directory-card-status-dot" aria-hidden="true" />
              {isOffline ? 'OFFLINE' : 'ONLINE'}
            </span>
          </h3>
          <div class="directory-card-host">{server.hostname}:{server.port}{server.tls ? ' (TLS)' : ''}</div>
        </div>
      </header>

      <div class="directory-card-body">
        {server.description && (
          <p class="directory-card-desc">{server.description}</p>
        )}
        {(server.tags.length > 0 || isLocal || verified) && (
          <div class="directory-card-tags">
            {isLocal && <span class="directory-card-tag directory-card-tag-local">LOCAL</span>}
            {verified && <span class="directory-card-tag directory-card-tag-verified">VERIFIED</span>}
            {server.tags.map((t) => (
              <span key={t} class="directory-card-tag">{t.toUpperCase()}</span>
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
          {isCurrent && (
            <span class="directory-current-badge" title="You're connected to this server">
              CURRENTLY CONNECTED
            </span>
          )}
        </div>
      </div>

      <footer class="directory-card-footer">
        {showRemove && onRemove && (
          <button
            type="button"
            class="directory-local-remove"
            onClick={onRemove}
            title="Remove this local entry"
          >
            Remove
          </button>
        )}
        {engine && (
          connected ? (
            <span class="directory-list-joined">Joined</span>
          ) : (
            <Button
              variant="primary"
              size="sm"
              onClick={onConnect}
              disabled={!myHandle}
              title={myHandle ? `Connect as ${myHandle}` : 'Set up your handle first'}
            >
              Connect
            </Button>
          )
        )}
      </footer>
    </article>
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
function buildEditableProps(
  server: import('../../modules/directory').Server | import('../../modules/session').SavedServer,
  me: import('../../modules/directory').User | null | undefined,
  bloc: DirectoryBloc,
): {
  directoryEntry?: import('../ChatLayout/ServerSettings').DirectoryEntryProfile;
  onSaveProfile?: (
    patch: Partial<import('../ChatLayout/ServerSettings').DirectoryEntryProfile>,
  ) => Promise<void>;
} {
  // SavedServer doesn't carry the directory profile fields — only
  // hostname/port/tls/name/id. Narrow via a property check so TS
  // accepts the access pattern below without `any` casts.
  if (!('tags' in server)) return {};
  if (!me?.id || me.id === '__guest__') return {};
  if (server.registered_by !== me.id) return {};
  return {
    directoryEntry: {
      serverId: server.id,
      name: server.name,
      description: server.description ?? '',
      tags: server.tags ?? [],
      languages: server.languages ?? [],
      isNsfw: server.is_nsfw ?? false,
    },
    onSaveProfile: (patch) => bloc.updateServerProfile(server.id, patch),
  };
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

// "Add server manually" form (advanced mode). Local-only — never sent to the
// Boson directory backend. Sensible defaults: TLS on, port 6697. Submitting
// adds it to the merged directory list immediately; the connection itself
// still uses the regular Connect button.
interface AddLocalServerFormProps {
  onSubmit: (input: { name: string; hostname: string; port: number; tls: boolean }) => void;
  onCancel: () => void;
}

function AddLocalServerForm({ onSubmit, onCancel }: AddLocalServerFormProps) {
  const [name, setName] = useState('');
  const [hostname, setHostname] = useState('');
  const [port, setPort] = useState('6697');
  const [tls, setTls] = useState(true);
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
    onSubmit({ name: trimmedName, hostname: trimmedHost, port: portNum, tls });
  };

  return (
    <form class="directory-add-form" onSubmit={submit}>
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
          hint="6697 (TLS) or 6667 (plaintext)."
          error={err && err.toLowerCase().includes('port') ? err : undefined}
        >
          <Input
            value={port}
            onInput={(e) => setPort((e.target as HTMLInputElement).value)}
            autoComplete="off"
            spellcheck={false}
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

      <Toggle checked={tls} onChange={setTls} label="Use TLS (recommended)" />

      <div class="directory-add-actions">
        <Button type="button" variant="ghost" onClick={onCancel}>Cancel</Button>
        <Button type="submit" variant="primary">Add server</Button>
      </div>
    </form>
  );
}

interface EnginePillProps {
  state: EngineState;
  connectionsCount: number;
  connectedCount: number;
  connected: boolean;
  onOpenChat: () => void;
}

function EnginePill({ state, connectionsCount, connectedCount, connected, onOpenChat }: EnginePillProps) {
  // Multi-server label: "3 servers · 2 connected" when more than one. Falls
  // back to the original single-state label when nothing's open.
  const label = connectionsCount === 0
    ? `engine · ${state}`
    : connectionsCount === 1
      ? `engine · ${state}`
      : `${connectionsCount} servers · ${connectedCount} connected`;
  return (
    <button
      type="button"
      class={`engine-pill engine-pill-${state}`}
      onClick={onOpenChat}
      disabled={!connected}
      title={connected ? 'Open chat' : `Engine: ${state}`}
    >
      <span class="engine-pill-dot" aria-hidden="true" />
      <span class="engine-pill-label">{label}</span>
    </button>
  );
}

interface SetupPromptProps {
  directory: DirectoryService;
  identity: IdentityService;
  onDone: (user: User) => void;
}

function SetupPrompt({ directory, identity, onDone }: SetupPromptProps) {
  const [handle, setHandle] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // After account creation we hold the created user + the one-time recovery
  // code, and switch to the recovery-code view before finishing. onDone is
  // gated behind the user acknowledging they've saved the code.
  const [created, setCreated] = useState<User | null>(null);
  const [recoveryCode, setRecoveryCode] = useState<string | null>(null);

  const submit = async (e: Event) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const encrypted = identity.getPendingEncrypted();
      if (!encrypted) {
        throw new Error('identity not initialized — please sign in again');
      }
      // Store the recovery wrap alongside the password wrap at account
      // creation so the user has a recovery path from day one.
      const recovery = identity.getPendingRecovery();
      const user = await directory.setupMe(handle, encrypted, recovery?.recoveryBlob);
      const code = recovery?.recoveryCode ?? null;
      identity.clearPendingEncrypted();
      if (code) {
        // Show the code once, then finish.
        setCreated(user);
        setRecoveryCode(code);
      } else {
        onDone(user);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'setup failed');
    } finally {
      setBusy(false);
    }
  };

  if (recoveryCode && created) {
    return (
      <RecoveryCodeReveal
        code={recoveryCode}
        intro="Save your recovery code. It's the only way back into your synced
          passwords if you forget your login password — we can't recover it for you."
        onContinue={() => onDone(created)}
      />
    );
  }

  return (
    <form class="directory-setup-prompt" onSubmit={submit}>
      <div class="directory-setup-header">
        <div class="directory-prompt">$ boson account --init</div>
        <h2>Finish setting up your account</h2>
        <p>Pick a handle — your network-wide username.</p>
      </div>
      <Field label="Handle" hint="3+ chars. Alphanumeric + underscore. Changes cost 90 days." error={error ?? undefined}>
        <Input
          placeholder="handle"
          value={handle}
          onInput={(e) => setHandle((e.target as HTMLInputElement).value)}
          minLength={3}
          required
        />
      </Field>
      <Button type="submit" variant="primary" loading={busy} disabled={busy || handle.length < 3}>
        Save
      </Button>
    </form>
  );
}

