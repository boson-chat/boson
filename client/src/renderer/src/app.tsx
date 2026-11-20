import type preact from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { AuthProvider, AuthService, useAuthState } from './modules/auth';
import { signOutAndForget } from './modules/auth/sign-out';
import { SessionStore } from './modules/session';
import { DirectoryService } from './modules/directory';
import { NetworkDirectories } from './modules/directory/networks';
import { configureDirectorySources, syncDirectoriesToShell } from './modules/directory/sources';
import { EngineClient, type WebSocketCtor } from './modules/engine';
import { IDBChatHistoryStore, type ChatHistoryStore } from './modules/history';
import { IdentityService } from './modules/identity';
import { NickservSyncService } from './modules/chat/nickserv-sync.service';
import { BouncerSyncService } from './modules/chat/bouncer-sync.service';
import { HttpClient } from './shared/http/http.client';
import { windowSecureStorage } from './shared/secure-storage';
import { AtomLoader } from '@boson/shared';
import { LoginScreen } from './screens/LoginScreen';
import { DirectoryScreen } from './screens/DirectoryScreen';
import { TitleBar } from './screens/TitleBar/TitleBar';
import { UserSettings } from './screens/UserSettings/UserSettings';
import { NotificationsPanel, useUnreadNotes } from './screens/Notifications/NotificationsPanel';
import { Toasts } from './screens/Notifications/Toasts';
import { getNotificationFeed } from './modules/notifications/feed';
import { useNarrow } from './shared/narrow';
import { isMobile } from './shared/window-controls';
import { NetworkSignInHost } from './screens/NetworkSignIn/NetworkSignIn';
import { loadGuestSession, onGuestChange, type GuestSession } from './modules/guest/guest';
import { getMemoStore } from './modules/memos';
import { onOpenUserSettings } from './modules/ui/open-settings';
import { useUpdateState } from './modules/updater/updater';
import { CallOverlays } from './screens/Friends/CallOverlays';

interface AppProps {
  auth: AuthService;
  directory: DirectoryService;
  engine: EngineClient | null;
  identity: IdentityService;
  history: ChatHistoryStore;
  // The network directories (directory.boson.chat + any the user added).
  networks?: NetworkDirectories;
}

export function App({ auth, directory, engine, identity, history, networks }: AppProps) {
  return (
    <AuthProvider service={auth}>
      <AppShell auth={auth} directory={directory} engine={engine} identity={identity} history={history} networks={networks} />
    </AuthProvider>
  );
}

function AppShell({ auth, directory, engine, identity, history, networks }: AppProps) {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsSection, setSettingsSection] = useState<string | null>(null);
  // Elsewhere in the app can open settings at a section (the voice bar).
  useEffect(() => onOpenUserSettings((section) => {
    setSettingsSection(section);
    setSettingsOpen(true);
  }), []);
  // The notifications bell's list (it took over the Inbox).
  const [notesOpen, setNotesOpen] = useState(false);
  const narrow = useNarrow();
  // An update downloaded and ready: the title bar's "Update" pill opens
  // Settings → About, where "Restart to update" is.
  const update = useUpdateState();
  const { session } = useAuthState();
  const guest = useGuestSession();
  // Re-scope the memo store as the auth identity resolves. Guests
  // land on the synthetic `__guest__` userId so their inbox is
  // separated from any account's; account users key on their auth-service user id.
  useEffect(() => {
    const id = session?.user?.id ?? (guest ? '__guest__' : '');
    getMemoStore().setUserId(id);
    getNotificationFeed().setUserId(id);
  }, [session?.user?.id, guest]);
  // The bell's badge: unread mentions, DMs, memos, friend and call events.
  const unreadCount = useUnreadNotes();
  // The signed-in user's Boson handle (their nick) and profile image, from
  // the backend profile (/me); refreshed when settings close, where both can
  // be changed. The session's metadata cache starts empty on every sign-in,
  // so without this the title bar showed no profile image until one was
  // uploaded again on this device.
  const [profileHandle, setProfileHandle] = useState<string | null>(null);
  const [profileAvatar, setProfileAvatar] = useState<string | null>(null);
  const userId = session?.user?.id ?? null;
  useEffect(() => {
    if (!userId || settingsOpen) return;
    let live = true;
    directory.getMe().then((u) => {
      if (!live) return;
      setProfileHandle(u?.handle ?? null);
      setProfileAvatar(u?.avatar_url ?? null);
    }).catch(() => {});
    return () => { live = false; };
  }, [userId, settingsOpen, directory]);
  // Title-bar label preference:
  //   guest mode → guest nick + "guest" tag
  //   signed-in  → the handle (session metadata, which a rename updates at
  //                once; else the profile's); the email only until one is
  //                known
  //   neither    → null (TitleBar falls back to "Settings")
  const authedHandle = (session?.user?.user_metadata?.handle as string | undefined)
    ?? (userId ? profileHandle : null);
  // Settings' upload/remove writes the metadata (null when removed) for an
  // instant update; until then, the profile's.
  const metadata = session?.user?.user_metadata ?? {};
  const authedAvatar = 'avatar_url' in metadata
    ? (metadata['avatar_url'] as string | null | undefined) ?? null
    : (userId ? profileAvatar : null);
  const userLabel = guest ? guest.nick : (authedHandle ?? session?.user?.username ?? session?.user?.email ?? null);
  const userMode: 'guest' | 'account' | null = guest ? 'guest' : (session ? 'account' : null);
  return (
    <div class="app-frame">
      <TitleBar
        onOpenSettings={() => { setSettingsSection(null); setSettingsOpen(true); }}
        userLabel={userLabel}
        userMode={userMode}
        avatarUrl={userMode === 'account' ? authedAvatar : null}
        onOpenNotifications={() => setNotesOpen((o) => !o)}
        notificationsCount={unreadCount}
        notificationsOpen={notesOpen}
        updateReady={update.kind === 'ready' ? update.version : null}
        onOpenUpdate={() => { setSettingsSection('about'); setSettingsOpen(true); }}
      />
      <div class="app-frame-body">
        <Router directory={directory} engine={engine} identity={identity} history={history} networks={networks} />
      </div>
      <UserSettings
        open={settingsOpen}
        initialSection={settingsSection}
        onClose={() => setSettingsOpen(false)}
        authedHandle={authedHandle}
        authedEmail={session?.user?.email ?? null}
        // Same device cleanup as the directory's Sign out button: a bare
        // auth.signOut() would leave the identity secret in the keychain
        // and the saved session + scrollback behind for the next account.
        onSignOut={() => { void signOutAndForget({ auth, identity, history, sessionStore: new SessionStore() }); }}
        directory={directory}
        identity={identity}
        auth={auth}
      />
      {/* Private calls: calling, ringing, toasts. */}
      <CallOverlays />
      {/* "Sign in to <network>" (self-hosted networks' own accounts). */}
      <NetworkSignInHost />
      {/* In-app notifications, and the bell's list. */}
      <Toasts />
      {notesOpen && (
        <NotificationsPanel
          layout={narrow || isMobile() ? 'phone' : 'desktop'}
          onClose={() => setNotesOpen(false)}
          onOpenSettings={() => { setNotesOpen(false); setSettingsSection('notifications'); setSettingsOpen(true); }}
        />
      )}
    </div>
  );
}

// Stable identifier per top-level "view" we render below. Used as the
// `key` on the wrapper so swapping between login / directory / loading
// states re-mounts the wrapper and replays the CSS entrance animation —
// same trick the marketing site uses (see boson-chat/website's src/app.tsx).
type RouteKey = 'loading' | 'restoring' | 'auth-error' | 'guest' | 'login' | 'app';

function Router({ directory, engine, identity, history, networks }: {
  directory: DirectoryService;
  engine: EngineClient | null;
  identity: IdentityService;
  history: ChatHistoryStore;
  networks?: NetworkDirectories;
}) {
  const { session, loading, error } = useAuthState();
  const identityUnlocked = useIdentityUnlocked(identity);
  const guest = useGuestSession();
  // When the user has a persisted session, try the OS-keychain
  // restore path before showing the login form. `null` means "haven't tried
  // yet"; we render a loading shim during the single IPC round-trip. After
  // restore the `useIdentityUnlocked` hook flips the route automatically.
  const userId = session?.user?.id ?? null;
  const restored = useIdentityRestore(identity, userId);
  // The route rendered last time. When the login screen is already up, the
  // session it's waiting for (sign-in, or the email-confirmation deep link)
  // must not swap it for the restore shim: that unmounts LoginScreen and its
  // LoginBloc mid-sign-in, losing the unlock outcome — the error and the
  // recovery-code offer after a password reset.
  const lastKey = useRef<RouteKey | null>(null);
  // 'idle' with a user is the render before the restore effect has started.
  const restoring = restored === 'pending' || (restored === 'idle' && userId !== null);

  let key: RouteKey;
  let content: preact.ComponentChildren;
  if (error) {
    key = 'auth-error';
    content = <div class="loading" style="color: var(--danger)">Auth init failed: {error}</div>;
  } else if (loading) {
    key = 'loading';
    content = <div class="loading"><AtomLoader size={40} label="Loading" /><span>Loading…</span></div>;
  } else if (guest) {
    // Guest mode short-circuits the auth + identity gates entirely. The
    // DirectoryScreen accepts an optional `guestNick` and proceeds without
    // ever calling the backend's /me endpoint.
    key = 'guest';
    content = <DirectoryScreen directory={directory} networks={networks} engine={engine} identity={identity} history={history} guestNick={guest.nick} />;
  } else if (session && !identityUnlocked && restoring && lastKey.current !== 'login') {
    // The auth session is restored from the keychain at launch. If the keychain
    // has the user_secret too, we'll have unlocked the identity above. If not,
    // fall through to LoginScreen — the user needs to type their password.
    key = 'restoring';
    content = <div class="loading"><AtomLoader size={40} label="Restoring session" /><span>Restoring session…</span></div>;
  } else if (!session || !identityUnlocked) {
    key = 'login';
    content = <LoginScreen directory={directory} identity={identity} />;
  } else {
    key = 'app';
    content = <DirectoryScreen directory={directory} networks={networks} engine={engine} identity={identity} history={history} />;
  }

  lastKey.current = key;
  return (
    <div class="route-content" key={key}>
      {content}
    </div>
  );
}

// Hook into the guest-session localStorage record. Re-reads when the
// LoginScreen (or anywhere) emits the boson:guest:change event, so flipping
// into / out of guest mode propagates without a page reload.
function useGuestSession(): GuestSession | null {
  const [guest, setGuest] = useState<GuestSession | null>(() => loadGuestSession());
  useEffect(() => onGuestChange(() => setGuest(loadGuestSession())), []);
  return guest;
}

function useIdentityUnlocked(identity: IdentityService): boolean {
  const [unlocked, setUnlocked] = useState(identity.isUnlocked());
  useEffect(() => {
    return identity.subscribe((s) => setUnlocked(s.status === 'unlocked'));
  }, [identity]);
  return unlocked;
}

type RestoreStatus = 'idle' | 'pending' | 'done';

// Attempt a one-shot keychain restore each time we see a new authenticated
// userId. `done` means "either restored or confirmed-no-blob" — in both cases
// the router proceeds without the loading shim. We never re-attempt for the
// same userId so a sign-out + sign-in cycle re-enters from `idle` cleanly.
function useIdentityRestore(identity: IdentityService, userId: string | null): RestoreStatus {
  const [status, setStatus] = useState<RestoreStatus>('idle');
  useEffect(() => {
    if (!userId) { setStatus('idle'); return; }
    if (identity.isUnlocked()) { setStatus('done'); return; }
    let cancelled = false;
    setStatus('pending');
    void identity.restoreFromStorage(userId).finally(() => {
      if (!cancelled) setStatus('done');
    });
    return () => { cancelled = true; };
  }, [identity, userId]);
  return status;
}

export interface BuildAppOptions {
  // The boson auth service, e.g. https://auth.boson.chat.
  authUrl: string;
  bosonUrl: string;
  // The default network directory (VITE_DIRECTORY_URL), default
  // https://directory.boson.chat.
  directoryUrl?: string;
  // Dev builds: allow http:// directories on loopback.
  dev?: boolean;
  engineUrl?: string;
  engineToken?: string;
  // Stands in for WebSocket when the engine isn't reached over one (Wails).
  engineSocket?: WebSocketCtor;
}

export function buildApp(opts: BuildAppOptions): AppProps {
  // The refresh token is kept in the OS keychain (secure store), never in
  // localStorage. Without the desktop shell (vite dev in a browser) the
  // session lasts until reload.
  const auth = new AuthService(opts.authUrl, { storage: windowSecureStorage });
  const http = new HttpClient(opts.bosonUrl, {
    getToken: () => auth.getToken(),
    tokenRejected: (t) => auth.tokenRejected(t),
  });
  const directory = new DirectoryService(http);
  const sources = configureDirectorySources({
    defaultUrl: opts.directoryUrl,
    authUrl: opts.authUrl,
    allowLoopbackHttp: !!opts.dev,
  });
  // The desktop proxy may reach the user's directories (read-only) — tell it
  // which, now and whenever the list changes.
  syncDirectoriesToShell(sources);
  void sources.refreshDefault();
  const networks = new NetworkDirectories(
    sources,
    { getToken: () => auth.getToken(), tokenRejected: (t) => auth.tokenRejected(t) },
    undefined,
    // Old deployments (no directory service yet): the boson API's /servers.
    (p) => directory.listServers(p),
  );
  // Pass the real `windowSecureStorage` so the identity can persist to the
  // OS keychain. In tests, callers construct IdentityService with their own
  // in-memory implementation.
  const identity = new IdentityService(undefined, windowSecureStorage);
  const engine = opts.engineUrl && opts.engineToken
    ? new EngineClient({ url: opts.engineUrl, token: opts.engineToken }, opts.engineSocket ? { wsCtor: opts.engineSocket } : undefined)
    : null;
  // IDB store lazy-opens on first use, so constructing it here is free even
  // if the user never goes near chat. Keyed per (userId, serverId, channel)
  // inside the store so different accounts on the same device don't collide.
  const history: ChatHistoryStore = new IDBChatHistoryStore();

  // Sync NickServ passwords (E2E-encrypted) to the backend so they follow the
  // user across devices. Self-activating: it subscribes to identity unlock
  // (pull/merge) and credential-store changes (debounced push), and no-ops
  // while locked or when the keychain backing is unavailable. The identity
  // subscription keeps it referenced for the app's lifetime.
  new NickservSyncService(identity, directory).start();

  // Sync the global bouncer (ZNC/BNC) profile (E2E-encrypted) the same way —
  // pull on unlock, debounced push on change, no-op while locked.
  new BouncerSyncService(identity, directory).start();

  return { auth, directory, engine, identity, history, networks };
}
