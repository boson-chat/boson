// Screenshot harness — NOT part of the shipped app. Served only by the
// standalone Vite config (vite.config.ts) at /shots.html so Playwright
// can capture marketing screenshots of the REAL screens driven by mock data
// (scripted IRC events over a fake session — the same path the integration
// tests use). Never imported by main.tsx; never in the app build.
import { render } from 'preact';
import './styles.css';
import { ChatService } from './modules/chat';
import type { IrcEvent, EventListener } from './modules/engine';
import { ChatLayout } from './screens/ChatLayout';
import { AuthProvider } from './modules/auth';
import { DirectoryService } from './modules/directory';
import { IdentityService } from './modules/identity';
import { HttpClient } from './shared/http/http.client';
import { DirectoryScreen } from './screens/DirectoryScreen';
import { LoginScreen } from './screens/LoginScreen';
import { UserSettings } from './screens/UserSettings/UserSettings';
import { Inbox } from './screens/Inbox/Inbox';
import type { Memo } from './modules/memos';
import { ServerSettings } from './screens/ChatLayout/ServerSettings';
import { getThemeStore } from './modules/ui/theme';
import { VoiceController, setVoiceController, setVoiceSettings, type VoiceRoom } from './modules/voice';
import { createFakeVoiceBridge } from './modules/voice/voice.fake';

// ?theme=<id> (e.g. daylight) picks a built-in theme for the shot.
const themeParam = new URLSearchParams(location.search).get('theme');
if (themeParam) localStorage.setItem('boson:theme:v1', JSON.stringify({ active: themeParam }));
// Apply the saved theme (local storage), as main.tsx does in the app.
void getThemeStore().init();

// ---- Stub the desktop embed bridges so cards render rich content ----
type W = typeof window & { bosonUnfurl?: unknown; bosonSpotify?: unknown };
(window as W).bosonUnfurl = {
  fetch: async (url: string) => {
    if (url.includes('youtu')) {
      return { url, siteName: 'YouTube', title: 'Self-hosting IRC in 2026 — a quick tour', author: 'Nebula Labs', date: '2026-05-30T10:00:00Z', image: 'https://picsum.photos/seed/irctour/480/270' };
    }
    // Compact text card (no image) keeps the hero focused on chat, not photos.
    return {
      url, siteName: 'boson.chat',
      title: 'Boson — self-hosted IRC, modernized',
      description: 'A desktop client for self-hosted IRC: rich chat, media embeds, moderation, and services automation over an open protocol.',
    };
  },
};
(window as W).bosonSpotify = {
  fetch: async (url: string) => ({
    url, type: 'playlist', title: "Today's Coding Mix", subtitle: 'boson',
    cover: 'https://picsum.photos/seed/spotifycover/160/160',
    tracks: [
      { title: 'Nightcall', artist: 'Kavinsky', durationMs: 258000, previewUrl: 'x' },
      { title: 'Midnight City', artist: 'M83', durationMs: 244000, previewUrl: 'x' },
      { title: 'Resonance', artist: 'HOME', durationMs: 213000, previewUrl: 'x' },
      { title: 'Strobe', artist: 'deadmau5', durationMs: 636000 },
      { title: 'A Real Hero', artist: 'College, Electric Youth', durationMs: 264000, previewUrl: 'x' },
    ],
  }),
};

// ---- Fake session: capture the listener, expose emit() ----
function makeSession(): { emit(e: IrcEvent): void } {
  let listener: EventListener | null = null;
  return {
    serverId: 's1',
    join: () => {}, part: () => {}, privmsg: () => {}, names: () => {}, tagmsg: () => {},
    list: () => {}, away: () => {}, nick: () => {}, nickservIdentify: () => {}, raw: () => {},
    onEvent: (fn: EventListener) => { listener = fn; return () => { listener = null; }; },
    onChannelDirectory: () => () => {},
    onServicesFramework: () => () => {},
    servicesFramework: () => null,
    emit: (e: IrcEvent) => listener?.(e),
  } as unknown as { emit(e: IrcEvent): void };
}

const min = (n: number) => new Date(Date.now() - n * 60_000).toISOString();
const NICK = 'ada';
const CHAN = '#dev';

// ?voice=none|rooms|connected|error: the chat view on a server with (or
// without) voice channels, driven by an in-memory voice bridge.
const voiceMode = new URLSearchParams(location.search).get('voice');
function installVoice(): void {
  if (!voiceMode) return;
  if (new URLSearchParams(location.search).get('ptt')) setVoiceSettings({ mode: 'ptt', pttCode: 'Backquote' });
  // ?voice=manage|listener|kicked: voice channels under #dev, locks and
  // a listen-only room, and you may make and manage them.
  const managed = voiceMode === 'manage' || voiceMode === 'listener' || voiceMode === 'kicked';
  const managedRooms: VoiceRoom[] = [
    { id: 'general', name: 'General', kind: 'static', parent: '', position: 0, canJoin: true, canSpeak: true, canManage: false, participants: [
      { sessionId: 3, userId: 'usr_nova', name: 'nova', muted: false, deafened: false, speaking: true },
      { sessionId: 4, userId: 'usr_kestrel', name: 'kestrel', muted: true, deafened: false, speaking: false },
    ] },
    { id: 'afk', name: 'AFK', kind: 'static', parent: '', position: 1, canJoin: true, canSpeak: true, participants: [] },
    { id: 'dev-standup', name: 'Standup', kind: 'dynamic', parent: '#dev', position: 0, owner: { userId: 'usr_ada', name: NICK },
      minRole: 'member', speakRole: 'member', canManage: true, canJoin: true, canSpeak: true, participants: [
        { sessionId: 8, userId: 'usr_orbit', name: 'orbit', muted: false, deafened: false, speaking: false },
        { sessionId: 9, userId: 'usr_mox', name: 'mox', muted: false, deafened: false, speaking: true },
      ] },
    { id: 'dev-town-hall', name: 'Town hall', kind: 'dynamic', parent: '#dev', position: 1, owner: { userId: 'usr_nova', name: 'nova' },
      minRole: 'member', speakRole: 'op', canManage: voiceMode !== 'listener', canJoin: true, canSpeak: voiceMode !== 'listener', participants: [] },
    { id: 'dev-staff', name: 'Staff room', kind: 'dynamic', parent: '#dev', position: 2, owner: { userId: 'usr_nova', name: 'nova' },
      minRole: 'admin', speakRole: 'admin', requireChannelMembership: true, canManage: false, canJoin: false, canSpeak: false, participants: [] },
    { id: 'design-crit', name: 'Crit', kind: 'dynamic', parent: '#design', position: 0, owner: { userId: 'usr_pixel', name: 'pixel' },
      minRole: 'member', speakRole: 'member', canManage: false, canJoin: true, canSpeak: true, participants: [
        { sessionId: 12, userId: 'usr_pixel', name: 'pixel', muted: false, deafened: true, speaking: false },
      ] },
  ];
  const bridge = createFakeVoiceBridge({
    servers: voiceMode === 'none' ? {} : { 'irc.nebula.example': {} },
    permissions: managed ? { 'irc.nebula.example': { policy: 'registered', canCreate: true, createScope: 'any', foundedChannels: [] } } : {},
    rooms: managed ? { 'irc.nebula.example': managedRooms } : {
      'irc.nebula.example': [
        { id: 'general', name: 'General', participants: [
          { sessionId: 3, userId: 'usr_nova', name: 'nova', muted: false, deafened: false, speaking: true },
          { sessionId: 4, userId: 'usr_kestrel', name: 'kestrel', muted: true, deafened: false, speaking: false },
          { sessionId: 5, userId: 'usr_pixel', name: 'pixel', muted: false, deafened: true, speaking: false },
        ] },
        { id: 'pairing', name: 'Pairing', participants: [
          { sessionId: 8, userId: 'usr_orbit', name: 'orbit', muted: false, deafened: false, speaking: false },
        ] },
        { id: 'afk', name: 'AFK', participants: [] },
      ],
    },
    onJoin: (req, prev) => voiceMode === 'listener'
      ? {
        ...prev, status: 'connected', host: req.host, room: req.room, roomName: req.roomName, rttMs: 41, quality: 'good', listener: true,
        participants: [
          { sessionId: 1, userId: 'usr_ada', name: NICK, self: true, listener: true, muted: true, deafened: false, speaking: false, volume: 100 },
          { sessionId: 3, userId: 'usr_nova', name: 'nova', self: false, muted: false, deafened: false, speaking: true, volume: 100 },
        ],
      }
      : voiceMode === 'kicked'
        ? { ...prev, status: 'error', host: req.host, room: req.room, roomName: req.roomName, errorKind: 'kicked', error: 'Voice channel "Standup" was deleted by nova.', participants: [] }
        : voiceMode === 'error'
      ? { ...prev, status: 'error', host: req.host, room: req.room, roomName: req.roomName, errorKind: 'unreachable', error: "Couldn't reach the voice server. Check your connection and try again." }
      : {
        ...prev, status: 'connected', host: req.host, room: req.room, roomName: req.roomName, rttMs: 34, quality: 'good',
        transmitting: true, micLevel: 0.7,
        participants: [
          { sessionId: 1, userId: 'usr_ada', name: NICK, self: true, muted: false, deafened: false, speaking: true, volume: 100 },
          { sessionId: 3, userId: 'usr_nova', name: 'nova', self: false, muted: false, deafened: false, speaking: true, volume: 100 },
          { sessionId: 4, userId: 'usr_kestrel', name: 'kestrel', self: false, muted: true, deafened: false, speaking: false, volume: 100 },
          { sessionId: 5, userId: 'usr_pixel', name: 'pixel', self: false, muted: false, deafened: true, speaking: false, volume: 80 },
        ],
      },
  });
  const voice = new VoiceController(bridge, {
    authUrl: 'https://auth.boson.chat',
    voiceToken: async () => ({ token: 't', expiresAt: Date.now() + 300_000 }),
    pollMs: 3_600_000,
  });
  setVoiceController(voice);
  if (voiceMode === 'connected' || voiceMode === 'error') {
    setTimeout(() => { void voice.join('irc.nebula.example', { id: 'general', name: 'General' }, 'Nebula'); }, 100);
  }
  if (voiceMode === 'listener') {
    setTimeout(() => { void voice.join('irc.nebula.example', { id: 'dev-town-hall', name: 'Town hall' }, 'Nebula'); }, 100);
  }
  if (voiceMode === 'kicked') {
    setTimeout(() => { void voice.join('irc.nebula.example', { id: 'dev-standup', name: 'Standup' }, 'Nebula'); }, 100);
  }
}

function chatView(): void {
  installVoice();
  const session = makeSession();
  const chat = new ChatService(
    session as never,
    NICK,
    { history: { append: async () => {}, load: async () => [] } as never, scope: { userId: 'u', serverId: 's1', serverName: 'Nebula' } },
  );
  chat.attach();

  const layout = (
    <ChatLayout
      chat={chat}
      serverName="Nebula"
      serverHost={voiceMode ? 'irc.nebula.example' : undefined}
      myNick={NICK}
      servers={[
        { serverId: 's1', name: 'Nebula', engineState: 'connected' },
        { serverId: 's2', name: 'Pulsar', engineState: 'connected', unread: 4, mentions: 2 },
        { serverId: 's3', name: 'Quasar', engineState: 'connected' },
      ]}
      activeServerId="s1"
      onSelectServer={() => {}}
      onBrowseServers={() => {}}
    />
  );
  render(
    voiceMode ? <AuthProvider service={makeAuth(true)}>{layout}</AuthProvider> : layout,
    document.getElementById('app')!,
  );

  const pm = (from: string, message: string, mAgo: number, tags: Record<string, string> = {}): IrcEvent =>
    ({ Kind: 'PRIVMSG', From: from, Target: CHAN, Message: message, Tags: { time: min(mAgo), ...tags }, Raw: '' });

  // Build a populated channel with entirely fictional names.
  session.emit({ Kind: 'JOIN', From: NICK, Target: CHAN, Message: '', Raw: '' });
  session.emit({ Kind: '353', From: 'irc', Target: CHAN, Message: `~${NICK} @nova @kestrel %mox +pixel orbit relaybot NickServ`, Raw: '' });
  session.emit({ Kind: '366', From: 'irc', Target: CHAN, Message: '', Raw: '' });

  session.emit(pm('nova', 'morning all — pushed the new directory build last night', 14));
  session.emit(pm('kestrel', 'nice. here are the box numbers from the run:', 13));
  // Box-drawing table (one PRIVMSG per line → grouped + rendered as a table).
  for (const line of [
    '┌──────────────────┬───────────┬──────────────────────────┐',
    '│ Service          │ Port      │ What it is                │',
    '├──────────────────┼───────────┼──────────────────────────┤',
    '│ ircd             │ 6697      │ IRC server (TLS)          │',
    '│ services         │ 6666      │ NickServ / ChanServ       │',
    '│ api              │ 8080      │ REST + realtime API       │',
    '│ metrics          │ 3000      │ Dashboards                │',
    '└──────────────────┴───────────┴──────────────────────────┘',
  ]) session.emit(pm('kestrel', line, 12));

  session.emit(pm('nova', 'perfect. **metrics** are back up — dashboards here: https://example.com', 9));
  session.emit(pm('pixel', 'nice work. music while we ship? → https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M', 6));
  session.emit(pm('orbit', 'and a quick walkthrough of the release: https://www.youtube.com/watch?v=dQw4w9WgXcQ', 3));
  session.emit(pm('nova', `${NICK}: are you around? wanted your eyes on the \`#ops\` topic before we cut the build`, 1, { msgid: 'm-mention' }));

  chat.setActive(CHAN);
  // Expose the emitter so the screenshot driver can inject extra events (e.g.
  // finalize an empty ban list when the Channel Settings modal is open).
  (window as W & { __emit?: (e: IrcEvent) => void }).__emit = (e) => session.emit(e);
  // Let images/cards load, then pin to the newest message for the shot.
  const pin = (): void => {
    const el = document.querySelector('.chat-messages');
    if (el) el.scrollTop = el.scrollHeight;
  };
  setTimeout(pin, 400);
  setTimeout(pin, 1200);
}

// ---- Mock backend API (HttpClient routes through window.bosonApi) ----
const USER = {
  id: 'u1', handle: 'ada', display_name: 'Ada', is_discoverable: true,
  avatar_url: 'https://picsum.photos/seed/ada/96/96',
  encrypted_user_secret: 'AAAA', created_at: '2026-01-01T00:00:00Z',
};
const SERVERS = [
  mkServer('s1', 'Helix', 'irc.helix.example', 'A friendly community for self-hosters, devs, and tinkerers.', ['community', 'tech', 'selfhosted'], ['English'], 412, true, 'irc1'),
  mkServer('s2', 'Aurora', 'irc.aurora.example', 'Open-source projects and maintainers hang out here.', ['foss', 'dev'], ['English'], 1280, true, 'irc2'),
  mkServer('s3', 'Tokyo Net', 'irc.tokyo.example', '日本語と英語のチャット。アニメ、ゲーム、技術。', ['anime', 'games', 'jp'], ['日本語', 'English'], 233, false, 'irc3'),
  mkServer('s4', 'Café Lumière', 'irc.lumiere.example', 'Salon francophone — culture, code et café.', ['general', 'fr'], ['Français'], 98, false, 'irc4'),
  mkServer('s5', 'RetroHub', 'irc.retrohub.example', 'Vintage computing, demoscene, and chiptune.', ['retro', 'demoscene'], ['English'], 156, false, 'irc5'),
  mkServer('s6', 'Mesh', 'irc.mesh.example', 'Privacy, crypto, and decentralized everything.', ['privacy', 'crypto'], ['English'], 64, false, 'irc6'),
];
function mkServer(id: string, name: string, hostname: string, description: string, tags: string[], languages: string[], user_count: number, is_featured: boolean, iconSeed: string) {
  return {
    id, hostname, port: 6697, tls: true, name, description, tags, languages,
    is_nsfw: false, is_featured, verification_status: 'verified', health_status: 'up',
    user_count, registered_at: '2026-02-01T00:00:00Z',
    icon_url: `https://picsum.photos/seed/${iconSeed}/72/72`,
  };
}
function installApi(signedIn: boolean): void {
  const json = (body: unknown, status = 200) => ({ status, ok: status < 400, statusText: 'OK', text: JSON.stringify(body) });
  (window as W & { bosonApi?: unknown }).bosonApi = {
    fetch: async (req: { method: string; url: string }) => {
      const path = new URL(req.url).pathname;
      if (path === '/servers/me') return json({ servers: [], count: 0 });
      if (path === '/servers') return json({ servers: SERVERS, count: SERVERS.length });
      if (path === '/me') return signedIn ? json(USER) : json({ error: 'unauthenticated' }, 401);
      if (path === '/me/session') return json({ payload: null });
      if (path.startsWith('/me/nickserv-secrets') || path.startsWith('/me/bouncer')) return json({});
      return json({}, 404);
    },
  };
}

// ---- Minimal fake AuthService (structurally compatible) ----
function makeAuth(signedIn: boolean) {
  const session = signedIn
    ? { access_token: 'jwt', expires_at: Date.now() + 900_000, refresh_token: 'r', session_id: 'ses_1', user: { id: 'usr_1', username: 'ada', email: 'ada@example.com', email_verified: true, role: 'user', user_metadata: { handle: 'ada' } } }
    : null;
  const state = { session, loading: false, error: null };
  return {
    init: async () => {},
    getState: () => state,
    subscribe: () => () => {},
    getToken: async () => (signedIn ? 'jwt' : null),
    signIn: async () => {}, signUp: async () => ({ verificationRequired: true }), signOut: async () => {},
    resendVerification: async () => {}, requestPasswordReset: async () => {}, tokenRejected: async () => null,
    updateMetadata: async () => {}, markFatal: () => {},
    // ?sso=…: "Sign in with …" providers, and what signing in with one does.
    config: async () => ({ sso_providers: [
      { slug: 'dex', kind: 'oidc', display_name: 'Dex', start_url: 'https://auth.boson.chat/v1/sso/dex/start' },
      { slug: 'okta', kind: 'saml', display_name: 'Okta', start_url: 'https://auth.boson.chat/v1/sso/okta/start' },
    ] }),
    exchangeSSOCode: async () => {
      const s = { access_token: 'jwt', expires_at: Date.now() + 900_000, refresh_token: 'r', session_id: 'ses_2', user: { id: 'usr_2', username: 'ada', email: null, email_verified: false, role: 'user', user_metadata: {} } };
      (state as { session: unknown }).session = s;
      return s;
    },
    identities: async () => ({ has_password: true, identities: [
      { id: 'uid_1', provider_id: 'idp_1', provider_slug: 'dex', provider_kind: 'oidc', provider_display_name: 'Dex', subject: 'CgVhZGEx', email: 'ada@example.com', created_at: '2026-11-01T00:00:00Z', last_login_at: '2026-11-12T09:00:00Z' },
      { id: 'uid_2', provider_id: 'idp_2', provider_slug: 'okta', provider_kind: 'saml', provider_display_name: 'Okta', subject: '00u1abcd', email: null, created_at: '2026-11-02T00:00:00Z', last_login_at: null },
    ] }),
    unlinkIdentity: async () => {},
  } as never;
}

function makeIdentity(): IdentityService {
  const svc = new IdentityService((password: string, salt: Uint8Array) => {
    const out = new Uint8Array(32);
    for (let i = 0; i < 32; i++) out[i] = (password.charCodeAt(i % Math.max(password.length, 1)) + salt[i]!) & 0xff;
    return out;
  });
  return svc;
}

function directoryService(): DirectoryService {
  return new DirectoryService(new HttpClient('https://api.boson.chat', { getToken: async () => 'jwt' }));
}

const app = () => document.getElementById('app')!;

function directoryView(): void {
  installApi(true);
  render(
    <AuthProvider service={makeAuth(true)}>
      <DirectoryScreen directory={directoryService()} engine={null} identity={makeIdentity()} />
    </AuthProvider>,
    app(),
  );
}

function authView(): void {
  const sso = new URLSearchParams(location.search).get('sso');
  installApi(sso === 'unlock');
  if (sso === 'new') {
    (window as W & { bosonApi?: unknown }).bosonApi = {
      fetch: async () => ({ status: 404, ok: false, statusText: 'Not Found', text: JSON.stringify({ error: 'not_found' }) }),
    };
  }
  if (sso) {
    (window as W & { bosonSSO?: unknown }).bosonSSO = {
      begin: async () => ({ id: 'f1', redirectUri: 'http://127.0.0.1:5555/callback?s=x' }),
      wait: async () => (sso === 'waiting' ? new Promise(() => {}) : { code: 'bsc_1' }),
      cancel: async () => {},
      open: async () => {},
    };
  }
  render(
    <AuthProvider service={makeAuth(false)}>
      <LoginScreen directory={directoryService()} identity={makeIdentity()} />
    </AuthProvider>,
    app(),
  );
}

function settingsView(): void {
  installApi(true);
  installVoice();
  render(
    <AuthProvider service={makeAuth(true)}>
      <UserSettings
        open
        onClose={() => {}}
        authedHandle="ada"
        authedEmail="ada@example.com"
        onSignOut={() => {}}
        directory={directoryService()}
        identity={makeIdentity()}
        auth={makeAuth(true)}
        initialSection={new URLSearchParams(location.search).get('section')}
      />
    </AuthProvider>,
    app(),
  );
}

const MEMOS: Memo[] = [
  { id: 'm1', serverId: 's1', serverName: 'Nebula', sender: 'MemoServ', kind: 'memo', read: false,
    text: 'memo from nova: ship is blocked on the TLS cert renewal — can you take a look before the 3pm cut?',
    timestamp: Date.now() - 4 * 60_000, memoIndex: 3, bodyFetched: true } as Memo,
  { id: 'm2', serverId: 's1', serverName: 'Nebula', sender: 'kestrel', kind: 'dm', read: false,
    text: 'are the release notes ready? want to attach them to the announcement', timestamp: Date.now() - 22 * 60_000 } as Memo,
  { id: 'm3', serverId: 's1', serverName: 'Nebula', sender: 'NickServ', kind: 'service', read: true,
    text: 'You are now identified for ada.', timestamp: Date.now() - 26 * 60_000 } as Memo,
  { id: 'm4', serverId: 's2', serverName: 'Helix', sender: 'MemoServ', kind: 'memo', read: true,
    text: 'memo from orbit: welcome to the network! ping an op in #help if you need anything.',
    timestamp: Date.now() - 3 * 3600_000, memoIndex: 2, bodyFetched: true } as Memo,
];
function inboxView(): void {
  render(<Inbox open memos={MEMOS} onClose={() => {}} />, app());
}

function servicesView(): void {
  const serverInfo = {
    serverName: 'irc.nebula.example', version: 'ngircd-27', network: 'Nebula',
    enabledCaps: ['sasl', 'server-time', 'message-tags', 'chathistory', 'account-notify'],
  };
  render(
    <ServerSettings
      serverDisplayName="Nebula"
      serverId="s1"
      myNick="ada"
      serverInfo={serverInfo as never}
      serverLog={[]}
      onClearServerLog={() => {}}
      onClose={() => {}}
      servicesFramework="atheme"
      signedIn
      onChangeNick={() => {}}
      onTriggerAutoIdentify={() => {}}
      onDetectAccountState={async () => 'identified'}
    />,
    app(),
  );
}

const view = new URLSearchParams(location.search).get('view') ?? 'chat';
if (view === 'chat') chatView();
else if (view === 'directory') directoryView();
else if (view === 'auth') authView();
else if (view === 'settings') settingsView();
else if (view === 'services') servicesView();
else if (view === 'inbox') inboxView();
else app().textContent = `unknown view: ${view}`;
