import { useEffect, useState } from 'preact/hooks';
import { AuthProvider, AuthService, useAuthState } from './modules/auth';
import { DirectoryService } from './modules/directory';
import { EngineClient } from './modules/engine';
import { IDBChatHistoryStore, type ChatHistoryStore } from './modules/history';
import { IdentityService } from './modules/identity';
import { HttpClient } from './shared/http/http.client';
import { windowSecureStorage } from './shared/secure-storage';
import { LoginScreen } from './screens/LoginScreen';
import { DirectoryScreen } from './screens/DirectoryScreen';
import { TitleBar } from './screens/TitleBar/TitleBar';
import { UserSettings } from './screens/UserSettings/UserSettings';
import { loadGuestSession, onGuestChange, type GuestSession } from './modules/guest/guest';

interface AppProps {
  auth: AuthService;
  directory: DirectoryService;
  engine: EngineClient | null;
  identity: IdentityService;
  history: ChatHistoryStore;
}

export function App({ auth, directory, engine, identity, history }: AppProps) {
  return (
    <AuthProvider service={auth}>
      <AppShell auth={auth} directory={directory} engine={engine} identity={identity} history={history} />
    </AuthProvider>
  );
}

function AppShell({ auth, directory, engine, identity, history }: AppProps) {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const { session } = useAuthState();
  const guest = useGuestSession();
  // Title-bar label preference:
  //   guest mode → guest nick + "guest" tag
  //   signed-in  → handle from metadata, fallback to email
  //   neither    → null (TitleBar falls back to "Settings")
  const authedHandle = (session?.user?.user_metadata?.handle as string | undefined) ?? null;
  const userLabel = guest ? guest.nick : (authedHandle ?? session?.user?.email ?? null);
  const userMode: 'guest' | 'account' | null = guest ? 'guest' : (session ? 'account' : null);
  return (
    <div class="app-frame">
      <TitleBar
        onOpenSettings={() => setSettingsOpen(true)}
        userLabel={userLabel}
        userMode={userMode}
      />
      <div class="app-frame-body">
        <Router directory={directory} engine={engine} identity={identity} history={history} />
      </div>
      <UserSettings
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        authedHandle={authedHandle}
        authedEmail={session?.user?.email ?? null}
        onSignOut={() => { void auth.signOut(); }}
      />
    </div>
  );
}

function Router({ directory, engine, identity, history }: {
  directory: DirectoryService;
  engine: EngineClient | null;
  identity: IdentityService;
  history: ChatHistoryStore;
}) {
  const { session, loading, error } = useAuthState();
  const identityUnlocked = useIdentityUnlocked(identity);
  const guest = useGuestSession();
  // When the user has a persisted Supabase session, try the OS-keychain
  // restore path before showing the login form. `null` means "haven't tried
  // yet"; we render a loading shim during the single IPC round-trip. After
  // restore the `useIdentityUnlocked` hook flips the route automatically.
  const userId = session?.user?.id ?? null;
  const restored = useIdentityRestore(identity, userId);
  if (error) return <div class="loading" style="color: var(--danger)">Auth init failed: {error}</div>;
  if (loading) return <div class="loading">Loading…</div>;
  // Guest mode short-circuits the auth + identity gates entirely. The
  // DirectoryScreen accepts an optional `guestNick` and proceeds without
  // ever calling the backend's /me endpoint.
  if (guest) {
    return <DirectoryScreen directory={directory} engine={engine} identity={identity} history={history} guestNick={guest.nick} />;
  }
  // Supabase may auto-restore a session from localStorage. If the keychain
  // has the user_secret too, we'll have unlocked the identity above. If not,
  // fall through to LoginScreen — the user needs to type their password.
  if (session && !identityUnlocked && restored === 'pending') {
    return <div class="loading">Restoring session…</div>;
  }
  if (!session || !identityUnlocked) return <LoginScreen directory={directory} identity={identity} />;
  return <DirectoryScreen directory={directory} engine={engine} identity={identity} history={history} />;
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
  supabaseUrl: string;
  anonKey: string;
  bosonUrl: string;
  engineUrl?: string;
  engineToken?: string;
}

export function buildApp(opts: BuildAppOptions): AppProps {
  const auth = new AuthService(opts.supabaseUrl, opts.anonKey);
  const http = new HttpClient(opts.bosonUrl, { getToken: () => auth.getToken() });
  const directory = new DirectoryService(http);
  // Pass the real `windowSecureStorage` so the identity can persist to the
  // OS keychain. In tests, callers construct IdentityService with their own
  // in-memory implementation.
  const identity = new IdentityService(undefined, windowSecureStorage);
  const engine = opts.engineUrl && opts.engineToken
    ? new EngineClient({ url: opts.engineUrl, token: opts.engineToken })
    : null;
  // IDB store lazy-opens on first use, so constructing it here is free even
  // if the user never goes near chat. Keyed per (userId, serverId, channel)
  // inside the store so different accounts on the same device don't collide.
  const history: ChatHistoryStore = new IDBChatHistoryStore();
  return { auth, directory, engine, identity, history };
}
