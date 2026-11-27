// Screenshot harness — NOT part of the shipped app. Served only by the
// standalone Vite config (vite.config.ts) at /shots.html so Playwright
// can capture marketing screenshots of the REAL screens driven by mock data
// (scripted IRC events over a fake session — the same path the integration
// tests use). Never imported by main.tsx; never in the app build.
import { render } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import './styles.css';
import './shared/modal-portal';
import { trackVisualViewport } from './shared/visual-viewport';
import { ChatService } from './modules/chat';
import { MemoryOlderStore } from './modules/history/older-store';
import type { IrcEvent, EventListener } from './modules/engine';
import { ChatLayout } from './screens/ChatLayout';
import { AuthProvider } from './modules/auth';
import { DirectoryService } from './modules/directory';
import { IdentityService } from './modules/identity';
import { HttpClient } from './shared/http/http.client';
import { DirectoryScreen } from './screens/DirectoryScreen';
import { LoginScreen } from './screens/LoginScreen';
import { UserSettings } from './screens/UserSettings/UserSettings';
import { clearGuestSession, saveGuestSession } from './modules/guest/guest';
import { NotificationsPanel, useUnreadNotes } from './screens/Notifications/NotificationsPanel';
import { setNotificationsOpener } from './modules/ui/open-notifications';
import { Toasts } from './screens/Notifications/Toasts';
import { getNotificationFeed } from './modules/notifications/feed';
import { startNotificationBridge } from './modules/notifications/bridge';
import { joinVoice, openCalls, openFriends } from './screens/Notifications/navigate';
import { getNotifier } from './modules/ui/notifier';
import { getMemoStore } from './modules/memos';
import { useNarrow } from './shared/narrow';
import type { Memo } from './modules/memos';
import type preact from 'preact';
import { ServerSettings } from './screens/ChatLayout/ServerSettings';
import { AuthService } from './modules/auth/auth.service';
import { InMemorySecureStorage } from './shared/secure-storage';
import { NetworkAccounts, setNetworkAccounts } from './modules/netauth/network-accounts';
import { App } from './app';
import { AccountDirectory } from './modules/directory/account-directory';
import { HomeAccountData, setHomeAuthSource } from './modules/netauth/home-account';
import { requestIdentityKey } from './modules/identity/key-request';
import { NetworkSignInHost } from './screens/NetworkSignIn/NetworkSignIn';
import { getThemeStore, NetworkThemes, setNetworkThemes, getNetworkThemes } from './modules/ui/theme';
import { setHomeNetwork } from './modules/netauth/home-network';
import { FilesController, setFiles } from './modules/files/files.service';
import type { FilesBridge } from './modules/files/files-bridge';
import { VoiceController, setVoiceController, setVoiceSettings, type VoiceRoom } from './modules/voice';
import { createFakeVoiceBridge } from './modules/voice/voice.fake';
import { VideoController, setVideoController, EMPTY_VIDEO_STATE, type VideoState } from './modules/video';
import { NetworkDirectories } from './modules/directory/networks';
import { FriendsController, HttpFriendsApi, setFriendsController } from './modules/friends';
import { FakeFriendsApi } from './modules/friends/friends.fake';
import { getVoiceController } from './modules/voice';
import { getVideoController } from './modules/video';
import { openCall } from './screens/ChatLayout/call-shared';
import { setFriendsUi } from './screens/Friends/friends-ui';
import { collectMyDms } from './screens/Friends/my-dms';
import { CallOverlays } from './screens/Friends/CallOverlays';
import { TitleBar } from './screens/TitleBar/TitleBar';
import { configureDirectorySources } from './modules/directory/sources';
import { fakeDirectory, fakeTransport, type FakeNetwork } from './modules/directory/test-directory-server';

// ?theme=<id> (e.g. daylight) picks a built-in theme for the shot.
const themeParam = new URLSearchParams(location.search).get('theme');
if (themeParam) localStorage.setItem('boson:theme:v1', JSON.stringify({ active: themeParam }));
// Apply the saved theme (local storage), as main.tsx does in the app.
void getThemeStore().init();
trackVisualViewport();

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

// ?reactions=1: what the fake server does with our TAGMSGs and other raw
// lines (echo-message: reactions and REDACTs come back to us).
let tagHook: ((target: string, tags: Record<string, string>) => void) | null = null;
let rawHook: ((line: string) => void) | null = null;

// ---- Fake session: capture the listener, expose emit() ----
function makeSession(): { emit(e: IrcEvent): void } {
  let listener: EventListener | null = null;
  return {
    serverId: 's1',
    join: () => {}, part: () => {}, names: () => {},
    tagmsg: (target: string, tags: Record<string, string>) => tagHook?.(target, tags),
    // ?chanserv=…: a scripted ChanServ answers (see chanservReplies).
    // Every line sent is kept in window.__sent (with its tags), and
    // confirmed (the engine's ACK) at once.
    privmsg: (target: string, body: string, ack?: number, tags?: Record<string, string>) => {
      const w = window as unknown as { __sent?: Array<{ target: string; body: string; tags?: Record<string, string> }> };
      (w.__sent ??= []).push({ target, body, ...(tags ? { tags } : {}) });
      if (ack) setTimeout(() => listener?.({ Kind: 'ACK', From: '', Target: '', Message: String(ack), Raw: '' }), 0);
      const lines = chanservReplies(target, body);
      if (lines) setTimeout(() => { for (const l of lines) listener?.({ Kind: 'NOTICE', From: target, Target: NICK, Message: l, Raw: '' }); }, 40);
    },
    list: () => {}, away: () => {}, nick: () => {}, nickservIdentify: () => {},
    raw: (line: string) => { rawHook?.(line); if (listener) searchHistoryAnswer(line, listener); },
    onEvent: (fn: EventListener) => { listener = fn; return () => { listener = null; }; },
    onChannelDirectory: () => () => {},
    onServicesFramework: () => () => {},
    servicesFramework: () => null,
    emit: (e: IrcEvent) => listener?.(e),
  } as unknown as { emit(e: IrcEvent): void };
}

const min = (n: number) => new Date(Date.now() - n * 60_000).toISOString();

// ?search=1: the server keeps history (CHATHISTORY), ~1200 scripted lines of
// #dev going back weeks, answered from here — for the full-page search's
// shots (Older results, the end of history, a result opened). &hist=N sets
// how many lines it keeps.
const searchMode = new URLSearchParams(location.search).get('search') === '1';
const SEARCH_LINES = Number(new URLSearchParams(location.search).get('hist') ?? 1200);
const searchHistory: Array<{ time: number; from: string; text: string; msgid: string }> = (() => {
  if (!searchMode) return [];
  const who = ['nova', 'kestrel', 'mox', 'pixel', 'orbit', 'jrmu'];
  const said = [
    'did the migration finish?',
    'the DNS record for chat. points at the old box still',
    'fixed, TTL is short so give it 5 minutes',
    'works now, thanks',
    'switched the resolver, DNS over TLS is on now',
    'can someone check the reverse DNS for the new VPS?',
    'propagation takes a while, DNS TTL was 3600',
    'deploy is green on staging',
    'who has the pager this week?',
    'rolling the ircd config now, expect a short netsplit',
    'the cert renewal cron ran at 04:00 as expected',
    'see https://status.nebula.example for the incident notes',
    'backups verified, restore test took 11 minutes',
    'bumping the relay to the new build',
  ];
  const now = Date.now() - 20 * 60_000;
  // Deterministic: the same history on every load.
  let seed = 7;
  const rnd = (n: number): number => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
  return Array.from({ length: SEARCH_LINES }, (_, i) => {
    const age = (SEARCH_LINES - i) * 47 * 60_000;
    return { time: now - age, from: who[rnd(who.length)]!, text: said[rnd(said.length)]!, msgid: `sh-${i}` };
  });
})();
let searchBatch = 0;
function searchHistoryAnswer(line: string, emit: EventListener): void {
  if (!searchMode) return;
  const [cmd, sub = '', target = '', ref = '', limitArg = '50'] = line.split(' ');
  if (cmd !== 'CHATHISTORY' || target.toLowerCase() !== CHAN) return;
  const limit = Number(limitArg) || 50;
  const [kind, value = ''] = ref.split('=');
  const at = kind === 'timestamp' ? Date.parse(value) : searchHistory.find((l) => l.msgid === value)?.time ?? Date.now();
  const all = searchHistory;
  let page: typeof all = [];
  if (sub === 'LATEST') page = all.slice(-limit);
  else if (sub === 'BEFORE') page = all.filter((l) => l.time < at).slice(-limit);
  else if (sub === 'AROUND') {
    const i = all.findIndex((l) => l.time >= at);
    page = all.slice(Math.max(0, i - Math.floor(limit / 2)), Math.max(0, i - Math.floor(limit / 2)) + limit);
  }
  const ref2 = `sb${++searchBatch}`;
  setTimeout(() => {
    emit({ Kind: 'BATCH', From: 'irc', Target: '', Message: '', Args: [`+${ref2}`, 'chathistory', target], Raw: '' });
    for (const l of page) {
      emit({ Kind: 'PRIVMSG', From: l.from, Target: target, Message: l.text, Tags: { batch: ref2, time: new Date(l.time).toISOString(), msgid: l.msgid }, Raw: '' });
    }
    emit({ Kind: 'BATCH', From: 'irc', Target: '', Message: '', Args: [`-${ref2}`], Raw: '' });
  }, 350);
}

// ?chanserv=ergo|anope|atheme|unregistered|guest|unreadable|offer: the
// channel's ChanServ registration, driven by scripted services replies.
const chanservMode = new URLSearchParams(location.search).get('chanserv');
const csState = { registered: chanservMode !== 'unregistered' && chanservMode !== 'guest' };
function chanservReplies(target: string, body: string): string[] | null {
  if (!chanservMode || target !== 'ChanServ') return null;
  const [cmd = '', ...rest] = body.split(' ');
  const verb = cmd.toUpperCase();
  if (chanservMode === 'unreadable') {
    return ['Information für den Raum \x02#dev\x02:', '     Gründer: ada', '  Registriert: Nov 14 10:00:00 2026 UTC'];
  }
  if (chanservMode === 'anope') {
    if (verb === 'INFO') return [
      'Information for channel \x02#dev\x02:', '        Founder: ada', '      Successor: nova', '    Description: Development talk',
      '     Registered: Nov 02 10:00:00 2026 UTC (12 days ago)', '      Last used: Nov 14 09:12:00 2026 UTC (now)', '       Ban type: 2',
      '        Options: Topic retention, Topic lock, Secure ops, Peace', '        Expires: Dec 14 09:12:00 2026 UTC (29 days from now)',
    ];
    if (verb === 'ACCESS') return ['Access list for #dev:', '  Number  Level  Mask', '  1       SOP    nova', '  2       AOP    kestrel', '  3       HOP    mox', '  4       VOP    pixel', 'End of access list'];
    return ['Topic lock option for #dev is now \x02on\x02.'];
  }
  if (chanservMode === 'atheme') {
    if (verb === 'INFO') return [
      'Information on \x02#dev\x02:', 'Founder    : ada', 'Successor  : (none)', 'Registered : Nov 02 10:00:00 2026 +0000 (1w 5d ago)',
      'Last used  : Nov 14 09:12:00 2026 +0000 (4m 10s ago)', 'Mode lock  : +nt', 'Flags      : GUARD SECURE TOPICLOCK', '\x02*** End of Info ***\x02',
    ];
    if (verb === 'FLAGS' && rest.length === 1) return [
      'Entry    Nickname/Host          Flags', '----------------------------------------------------------------',
      '1        ada                    +AFRefiorstv         (FOUNDER) [modified 1w 5d ago, on Nov 02 10:00:00 2026 +0000, by ada]',
      '2        nova                   +AOehiortv           (SOP) [modified 2d ago, on Nov 12 10:00:00 2026 +0000, by ada]',
      '3        kestrel                +AOiortv             (AOP) [modified 2d ago, on Nov 12 10:00:00 2026 +0000, by ada]',
      '----------------------------------------------------------------', 'End of \x02#dev\x02 FLAGS listing.',
    ];
    return null;
  }
  // Ergo (default), unregistered, guest, offer.
  if (verb === 'INFO') return csState.registered
    ? ['Channel #dev is registered', `Founder: ${chanservMode === 'offer' ? 'nova' : NICK}`, 'Registered at: Mon, 02 Nov 2026 10:00:00 UTC', 'Last activity: Sat, 14 Nov 2026 09:12:00 UTC']
    : ['Channel #dev is not registered'];
  if (verb === 'GET') return ['The stored channel history setting is: default', 'Given current server settings, the channel history setting is: on'];
  if (verb === 'AMODE') return ['Channel #dev has 5 persistent modes set', `Account ${NICK} receives mode +q`, 'Account nova receives mode +a', 'Account kestrel receives mode +o', 'Account mox receives mode +h', 'Account pixel receives mode +v'];
  if (verb === 'REGISTER') { csState.registered = true; return ['Channel #dev successfully registered']; }
  return null;
}
const NICK = 'ada';
const CHAN = '#dev';

// ?voice=guest: as a guest (no account) on a server that allows guest
// voice, in a call with another guest.
// ?voice=none|rooms|connected|error: the chat view on a server with (or
// without) voice channels, driven by an in-memory voice bridge.
const voiceMode = new URLSearchParams(location.search).get('voice');
const capKbps = Number(new URLSearchParams(location.search).get('cap') ?? 0);
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
        // ?people=N: everyone but us is in General (before we join).
        { id: 'general', name: 'General', participants: new URLSearchParams(location.search).has('people')
          ? callPeople().filter((p) => !p.self).map(({ sessionId, userId, name, muted, deafened, speaking }) => ({ sessionId, userId, name, muted, deafened, speaking }))
          : [
            { sessionId: 3, userId: 'usr_nova', name: 'nova', muted: false, deafened: false, speaking: true },
            { sessionId: 4, userId: 'usr_kestrel', name: 'kestrel', muted: true, deafened: false, speaking: false },
            { sessionId: 5, userId: 'usr_pixel', name: 'pixel', muted: false, deafened: true, speaking: false },
            ...(voiceMode === 'guest' ? [{ sessionId: 6, userId: 'guest:k3d9sQvB0aXw2LmN', name: 'wren', muted: false, deafened: false, speaking: false, guest: true }] : []),
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
        // ?cap=48: the channel caps voice at 48 kbit/s.
        ...(capKbps ? { maxBitrate: capKbps * 1000, bitrate: capKbps * 1000 } : {}),
        participants: callPeople(),
      },
  });
  const voice = new VoiceController(bridge, {
    authUrl: 'https://auth.boson.chat',
    voiceToken: async () => ({ token: 't', expiresAt: Date.now() + 300_000 }),
    pollMs: 3_600_000,
    ...(voiceMode === 'guest' ? {
      hasAccount: () => false,
      guestVoice: async () => true,
      guestVoiceToken: async () => ({ token: 'g', expiresAt: Date.now() + 300_000 }),
    } : {}),
  });
  setVoiceController(voice);
  if (voiceMode === 'connected' || voiceMode === 'error' || voiceMode === 'guest') {
    setTimeout(() => { void voice.join('irc.nebula.example', { id: 'general', name: 'General' }, 'Nebula'); }, 100);
  }
  if (voiceMode === 'listener') {
    setTimeout(() => { void voice.join('irc.nebula.example', { id: 'dev-town-hall', name: 'Town hall' }, 'Nebula'); }, 100);
  }
  if (voiceMode === 'kicked') {
    setTimeout(() => { void voice.join('irc.nebula.example', { id: 'dev-standup', name: 'Standup' }, 'Nebula'); }, 100);
  }
}

// ?people=N (1–9): how many are in the call (default 4, ourselves first).
const EXTRA = ['orbit', 'mox', 'quill', 'ember', 'sage', 'ash', 'bix', 'cora', 'dune', 'eli', 'fern', 'gage', 'hale', 'iris', 'jett', 'kai', 'lux', 'moss', 'opal', 'pike', 'rook', 'tove', 'vale', 'wren'];
function callPeople() {
  const all = [
    { sessionId: 1, userId: 'usr_ada', name: NICK, self: true, muted: false, deafened: false, speaking: !look, volume: 100 },
    { sessionId: 3, userId: 'usr_nova', name: 'nova', self: false, muted: false, deafened: false, speaking: true, volume: 100 },
    { sessionId: 4, userId: 'usr_kestrel', name: 'kestrel', self: false, muted: true, deafened: false, speaking: false, volume: 100 },
    { sessionId: 5, userId: 'usr_pixel', name: 'pixel', self: false, muted: false, deafened: true, speaking: false, volume: 80 },
    ...(voiceMode === 'guest' ? [{ sessionId: 6, userId: 'guest:k3d9sQvB0aXw2LmN', name: 'wren', self: false, muted: false, deafened: false, speaking: false, volume: 100 }] : []),
    ...EXTRA.map((n, i) => ({ sessionId: 20 + i, userId: `usr_${n}`, name: n, self: false, muted: i % 4 === 1, deafened: false, speaking: false, volume: 100 })),
  ];
  const n = Number(new URLSearchParams(location.search).get('people') ?? 4);
  return all.slice(0, Math.max(1, Math.min(all.length, n || 4)));
}

const PICKER_SOURCES = [
  { id: 'display:1', name: 'Screen 1 (main)', kind: 'display' as const, width: 3024, height: 1964, main: true, hasSelf: true },
  { id: 'display:2', name: 'Screen 2', kind: 'display' as const, width: 5120, height: 2880 },
  { id: 'window:7', name: 'zsh — Terminal', kind: 'window' as const, app: 'Terminal', title: 'zsh — make netem' },
  { id: 'window:8', name: 'quicvideo — design.md', kind: 'window' as const, app: 'Code', title: 'quicvideo — design.md' },
  { id: 'window:9', name: 'boson.chat — Safari', kind: 'window' as const, app: 'Safari', title: 'boson.chat — Directory' },
  { id: 'window:10', name: 'Release notes — Pages', kind: 'window' as const, app: 'Pages', title: 'Release notes 0.73' },
];
const thumbCache = new Map<string, string>();
function pickerThumb(id: string): string {
  let url = thumbCache.get(id);
  if (url) return url;
  const c = document.createElement('canvas');
  c.width = 320; c.height = 200;
  const g = c.getContext('2d')!;
  const hue = [...id].reduce((a, ch) => a + ch.charCodeAt(0), 0) % 360;
  g.fillStyle = `hsl(${hue},25%,14%)`; g.fillRect(0, 0, 320, 200);
  g.fillStyle = `hsl(${hue},30%,26%)`; g.fillRect(24, 24, 180, 120);
  g.fillStyle = `hsl(${hue},20%,20%)`; g.fillRect(150, 70, 140, 100);
  g.fillStyle = 'rgba(255,255,255,0.6)'; g.font = '14px monospace'; g.fillText(id, 32, 48);
  url = c.toDataURL('image/jpeg', 0.7);
  thumbCache.set(id, url);
  return url;
}

// ?video=live&ws=<frame hub URL>: the call view on a real frame socket and
// the browser's real WebCodecs decoder: nova's camera is track 10, her
// screen track 11, and our camera's self-view comes as previews (the
// WebKit video test feeds it from Go: desktop/video_webkit_test.go).
function installLiveVideo(): void {
  const q = new URLSearchParams(location.search);
  // &pacing=1: "Smoother screen shares" on (the experimental flag).
  setVoiceSettings({ screenPacing: q.get('pacing') === '1' });
  const others = callPeople().filter((p) => !p.self);
  const layer = (w: number, h: number) => [{ id: 0, width: w, height: h, fps: 30 }];
  const state: VideoState = {
    ...EMPTY_VIDEO_STATE, available: true, status: 'connected', frameUrl: q.get('ws') ?? '', canCapture: true, canPublish: true,
    camera: { on: true, starting: false, facing: 'front' },
    tracks: others.length === 0 ? [] : [
      { trackId: 10, userId: others[0].userId, name: others[0].name, kind: 'camera', self: false, layers: layer(640, 360) },
      { trackId: 11, userId: others[0].userId, name: others[0].name, kind: 'screen', self: false, layers: layer(1280, 720) },
    ],
  };
  const bridge = {
    state: async () => state, onState: () => () => {}, subscribe: async () => {}, unsubscribe: async () => {},
    cameras: async () => [], screenSources: async () => [], setCamera: async () => state, setScreen: async () => state,
  };
  const c = new VideoController(bridge);
  setVideoController(c);
  (globalThis as unknown as { __video: VideoController }).__video = c; // the test reads its stats
  setTimeout(() => c.setOpen(true), 400);
}


// ?look=1 (with ?video=…): marketing-style frames instead of labelled test
// patterns: a drawn head-and-shoulders figure per camera (no real faces)
// and a code editor for a screen share.
const q0 = new URLSearchParams(location.search);
const repliesMode = q0.get('replies');
const threadsMode = q0.get('threads') === '1';
const look = q0.get('look') === '1';
const portrait = q0.get('portrait') === '1';
const LOOKS: Record<number, { wall: [string, string]; shirt: string; skin: string; hair: string; long?: boolean }> = {
  0: { wall: ['#3b4a5e', '#1f2733'], shirt: '#d9822b', skin: '#e0b48f', hair: '#2b1d14', long: true },
  10: { wall: ['#2f4f5f', '#18262e'], shirt: '#3d6fb6', skin: '#c58c64', hair: '#1c1410', long: true },
  12: { wall: ['#5a4a3a', '#2a221a'], shirt: '#5a8f5a', skin: '#f0c9a8', hair: '#a8652f' },
  14: { wall: ['#4a3f5c', '#211b2b'], shirt: '#b84a5a', skin: '#8d5a3b', hair: '#121010' },
  16: { wall: ['#3f5a4a', '#1b2a22'], shirt: '#c9b458', skin: '#e8b996', hair: '#5a3a22', long: true },
  18: { wall: ['#5c4a4a', '#2b1f1f'], shirt: '#4a7a9a', skin: '#d4a07a', hair: '#2a2a2a' },
};
function paintPerson(c: OffscreenCanvas | HTMLCanvasElement, track: number): void {
  const g = c.getContext('2d') as CanvasRenderingContext2D;
  const { width: w, height: h } = c;
  const L = LOOKS[track] ?? LOOKS[18]!;
  const bg = g.createLinearGradient(0, 0, w * 0.4, h);
  bg.addColorStop(0, L.wall[0]); bg.addColorStop(1, L.wall[1]);
  g.fillStyle = bg; g.fillRect(0, 0, w, h);
  // a window's soft light and a shelf, for depth
  const glow = g.createRadialGradient(w * 0.85, h * 0.2, 0, w * 0.85, h * 0.2, Math.max(w, h) * 0.6);
  glow.addColorStop(0, 'rgba(255,240,220,0.22)'); glow.addColorStop(1, 'rgba(255,240,220,0)');
  g.fillStyle = glow; g.fillRect(0, 0, w, h);
  g.fillStyle = 'rgba(0,0,0,0.18)'; g.fillRect(0, h * 0.34, w * 0.22, h * 0.02);
  const s = Math.min(w, h * 0.9);
  const cx = w * 0.5;
  const headR = s * 0.15;
  const shouldersTop = h - s * 0.3;
  const headY = shouldersTop - headR * 1.55;
  // neck, then shoulders over its base
  g.fillStyle = L.skin;
  g.fillRect(cx - headR * 0.36, headY + headR * 0.6, headR * 0.72, shouldersTop - headY);
  g.fillStyle = L.shirt;
  g.beginPath();
  g.ellipse(cx, h + s * 0.12, s * 0.44, s * 0.42, 0, Math.PI, 0);
  g.fill();
  // long hair behind the head
  g.fillStyle = L.hair;
  if (L.long) { g.beginPath(); g.ellipse(cx, headY + headR * 0.55, headR * 1.12, headR * 1.45, 0, 0, Math.PI * 2); g.fill(); }
  // head
  g.fillStyle = L.skin;
  g.beginPath(); g.ellipse(cx, headY, headR * 0.86, headR * 1.05, 0, 0, Math.PI * 2); g.fill();
  // hair on top
  g.save();
  g.beginPath(); g.ellipse(cx, headY, headR * 0.92, headR * 1.1, 0, 0, Math.PI * 2); g.clip();
  g.fillStyle = L.hair;
  g.beginPath(); g.ellipse(cx, headY - headR * 0.95, headR * 1.3, headR * 0.85, 0, 0, Math.PI * 2); g.fill();
  g.restore();
  // soft vignette
  const v = g.createRadialGradient(cx, h * 0.5, Math.min(w, h) * 0.3, cx, h * 0.5, Math.max(w, h) * 0.75);
  v.addColorStop(0, 'rgba(0,0,0,0)'); v.addColorStop(1, 'rgba(0,0,0,0.35)');
  g.fillStyle = v; g.fillRect(0, 0, w, h);
}
const CODE = [
  ['k', 'func '], ['f', 'joinCall'], ['p', '(ctx context.Context, room string) error {'],
  null,
  ['p', '  ticket, err := voice.'], ['f', 'Ticket'], ['p', '(ctx, room)'],
  null,
  ['p', '  '], ['k', 'if '], ['p', 'err != nil {'],
  null,
  ['p', '    '], ['k', 'return '], ['p', 'fmt.'], ['f', 'Errorf'], ['p', '('], ['s', '"ticket: %w"'], ['p', ', err)'],
  null,
  ['p', '  }'],
  null,
  ['c', '  // video waits for its sound: lip sync'],
  null,
  ['p', '  sync := media.'], ['f', 'NewLipSync'], ['p', '(150 * time.Millisecond)'],
  null,
  ['p', '  conn, err := quic.'], ['f', 'DialAddr'], ['p', '(ctx, ticket.Addr, tlsConf, nil)'],
  null,
  ['p', '  '], ['k', 'if '], ['p', 'err != nil {'],
  null,
  ['p', '    '], ['k', 'return '], ['p', 'err'],
  null,
  ['p', '  }'],
  null,
  ['k', '  return '], ['p', 'publish(ctx, conn, sync)'],
  null,
  ['p', '}'],
] as const;
function paintScreen(c: OffscreenCanvas): void {
  const g = c.getContext('2d') as OffscreenCanvasRenderingContext2D;
  const { width: w, height: h } = c;
  g.fillStyle = '#1b1d23'; g.fillRect(0, 0, w, h);
  g.fillStyle = '#25282f'; g.fillRect(0, 0, w, 44);
  for (const [i, col] of ['#ff5f57', '#febc2e', '#28c840'].entries()) { g.fillStyle = col; g.beginPath(); g.arc(22 + i * 22, 22, 7, 0, Math.PI * 2); g.fill(); }
  g.fillStyle = '#9aa0ab'; g.font = '18px ui-monospace, Menlo, monospace'; g.fillText('call.go — quicvideo', w / 2 - 90, 28);
  g.fillStyle = '#20232a'; g.fillRect(0, 44, 240, h - 44);
  const files = ['client/', '  media/', '  call.go', '  lipsync.go', '  publish.go', 'server/', 'docs/', '  design.md'];
  g.font = '17px ui-monospace, Menlo, monospace';
  files.forEach((f, i) => { g.fillStyle = f.trim() === 'call.go' ? '#e8eaf0' : '#7d8390'; if (f.trim() === 'call.go') { g.fillStyle = '#2f3440'; g.fillRect(0, 72 + i * 34 - 22, 240, 32); g.fillStyle = '#e8eaf0'; } g.fillText(f, 20, 72 + i * 34); });
  const tone: Record<string, string> = { k: '#c678dd', f: '#61afef', p: '#d7dae0', s: '#98c379', c: '#6f7682' };
  g.font = '21px ui-monospace, Menlo, monospace';
  let x = 300; let y = 100; let line = 1;
  g.fillStyle = '#4b5263'; g.fillText(String(line), 262, y);
  for (const tok of CODE) {
    if (!tok) { y += 34; x = 300; line++; g.fillStyle = '#4b5263'; g.fillText(String(line).padStart(2), 256, y); continue; }
    g.fillStyle = tone[tok[0]]!; g.fillText(tok[1], x, y); x += g.measureText(tok[1]).width;
  }
  g.fillStyle = 'rgba(97,175,239,0.10)'; g.fillRect(240, 100 + 34 * 7 - 24, w - 240, 32);
}
// Our self-view as a preview frame (2, u16 width, u16 height, RGBA).
function lookPreview(w: number, h: number): Uint8Array {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  paintPerson(c, 0);
  const px = (c.getContext('2d') as CanvasRenderingContext2D).getImageData(0, 0, w, h).data;
  const out = new Uint8Array(5 + w * h * 4);
  const v = new DataView(out.buffer);
  out[0] = 2; v.setUint16(1, w); v.setUint16(3, h);
  out.set(px, 5);
  return out;
}

// ?video=call: the call view, with tiles drawn from painted test frames
// through the real controller (a fake socket sends keyframes; a fake
// decoder paints a labelled pattern per track). call: everyone else's
// camera and ours; screen: that plus a screen share; none: audio only.
// ?cams=one: only nova's camera.
const videoMode = new URLSearchParams(location.search).get('video');
function installVideo(): void {
  if (!videoMode) return;
  if (videoMode === 'live') return installLiveVideo();
  // &portrait=1: the others' cameras are portrait, as phones send.
  const camW = portrait ? 360 : 640;
  const camH = portrait ? 640 : 360;
  const cam = (id: number, userId: string, name: string) => ({
    trackId: id, userId, name, kind: 'camera' as const, self: false, layers: [{ id: 0, width: camW, height: camH, fps: 30 }],
  });
  const others = callPeople().filter((p) => !p.self);
  const oneCam = new URLSearchParams(location.search).get('cams') === 'one';
  // &sound=1: the screen share carries its sound, and "Share sound" is on offer.
  const withSound = new URLSearchParams(location.search).get('sound') === '1';
  const camTracks = videoMode === 'none' ? [] : others.slice(0, oneCam ? 1 : others.length).map((p, i) => cam(10 + i * 2, p.userId, p.name));
  const state: VideoState = {
    ...EMPTY_VIDEO_STATE, available: true, status: 'connected', frameUrl: 'ws://fake/video', canCapture: true, canPublish: true, canShareScreen: true, canPickScreen: true, canShareAudio: withSound,
    camera: { on: videoMode !== 'none', starting: false },
    tracks: [
      ...camTracks,
      ...(videoMode === 'screen' && others.length > 0
        ? [{ trackId: 11, userId: others[Math.min(1, others.length - 1)].userId, name: others[Math.min(1, others.length - 1)].name, kind: 'screen' as const, self: false, layers: [{ id: 0, width: 1920, height: 1080, fps: 15 }], ...(withSound ? { sound: true, volume: 100 } : {}) }]
        : []),
    ],
  };
  const colours: Record<number, string> = { 10: '#3a6ea5', 11: '#2d2f36', 12: '#7a4fa3', 14: '#2f8a6a', 16: '#a3643a', 18: '#3a8aa3', 20: '#8a3a5e', 22: '#5e7a2f', 24: '#4f5aa3' };
  // Our camera's self-view: a portrait picture, as a phone sends.
  const preview = look ? lookPreview(270, 360) : new Uint8Array(5 + 90 * 120 * 4);
  if (!look) {
    preview[0] = 2; preview[2] = 90; preview[4] = 120;
    for (let y = 0; y < 120; y++) for (let x = 0; x < 90; x++) {
      const o = 5 + (y * 90 + x) * 4;
      preview[o] = 200 - y; preview[o + 1] = 120 + x; preview[o + 2] = 90; preview[o + 3] = 255;
    }
  }
  class FakeSocket {
    binaryType = '';
    readyState = 1;
    onmessage: ((ev: { data: unknown }) => void) | null = null;
    onclose: (() => void) | null = null;
    private t: number;
    constructor(public url: string) {
      this.t = window.setInterval(() => {
        for (const tr of state.tracks) {
          const b = new Uint8Array(20 + 4 + 5);
          const v = new DataView(b.buffer);
          b[0] = 1; b[1] = 3;
          v.setUint32(2, tr.trackId);
          v.setBigUint64(10, BigInt(Date.now() * 1000));
          v.setUint16(18, 4);
          b.set([1, 0x42, 0xc0, 0x1e], 20);
          this.onmessage?.({ data: b.buffer });
        }
        if (state.camera.on) this.onmessage?.({ data: preview.slice().buffer });
      }, 100);
    }
    send() {}
    close() { clearInterval(this.t); }
  }
  class PaintDecoder {
    state = 'unconfigured';
    private track = 0;
    constructor(private init: { output: (f: VideoFrame) => void }) {}
    configure() { this.state = 'configured'; }
    decode(chunk: { timestamp: number }) {
      if (look) {
        const tr = state.tracks.find((t) => t.trackId === this.track);
        const w = tr?.layers[0]?.width ?? 640;
        const h = tr?.layers[0]?.height ?? 360;
        const lc = new OffscreenCanvas(this.track === 11 ? 1280 : w, this.track === 11 ? 720 : h);
        if (this.track === 11) paintScreen(lc); else paintPerson(lc, this.track);
        this.init.output(new VideoFrame(lc, { timestamp: chunk.timestamp }));
        return;
      }
      const c = new OffscreenCanvas(640, 360);
      const g = c.getContext('2d')!;
      const tr = [...state.tracks].find((t) => colours[t.trackId]) ?? state.tracks[0];
      void tr;
      g.fillStyle = colours[this.track] ?? '#444';
      g.fillRect(0, 0, 640, 360);
      g.fillStyle = 'rgba(255,255,255,0.85)';
      g.font = 'bold 42px sans-serif';
      g.fillText(this.track === 11 ? 'screen share' : 'camera', 40, 190);
      this.init.output(new VideoFrame(c, { timestamp: chunk.timestamp }));
    }
    close() { this.state = 'closed'; }
    setTrack(id: number) { this.track = id; }
  }
  // Each track's decoder is made on its first keyframe; tell it which.
  let next = 0;
  const ids = state.tracks.map((t) => t.trackId);
  class TrackedDecoder extends PaintDecoder {
    constructor(init: { output: (f: VideoFrame) => void }) { super(init); this.setTrack(ids[next++ % ids.length]); }
  }
  const bridge = {
    state: async () => state,
    onState: () => () => {},
    subscribe: async () => {},
    unsubscribe: async () => {},
    cameras: async () => [{ id: 'front', name: 'Front Camera', kind: 'builtin' as const, facing: 'front' as const, default: true }, { id: 'back', name: 'Back Camera', kind: 'builtin' as const, facing: 'back' as const, default: false }],
    // The screen share picker: two displays and some windows, with drawn
    // thumbnails.
    screenSources: async () => PICKER_SOURCES,
    screenThumbnails: async (ids: string[]) => Object.fromEntries(ids.map((id) => [id, pickerThumb(id)])),
    stopThumbnails: async () => {},
    setCamera: async () => state,
    setScreen: async () => state,
    setShareVolume: async (trackId: number, percent: number) => {
      state.tracks = state.tracks.map((t) => (t.trackId === trackId ? { ...t, volume: percent } : t));
      return { ...state };
    },
  };
  const c = new VideoController(bridge, {
    WebSocket: FakeSocket as unknown as typeof WebSocket,
    VideoDecoder: TrackedDecoder as unknown as typeof VideoDecoder,
  });
  setVideoController(c);
  setTimeout(() => c.setOpen(true), 400);
}

// ?friends=1: signed in, with friends (kestrel, mox who may call anytime),
// pixel (friends-only calls), a request from nova, orbit blocked.
// &fpage=1 opens the desktop Friends page; &tab=friends|calls the phone's
// tab; &ring=video|voice: kestrel calls; &calling=mox: calling mox
// (&answer=ms answers); &missed=N missed calls.
const friendsMode = new URLSearchParams(location.search).get('friends');
function installFriends(): void {
  if (!friendsMode) return;
  const q = new URLSearchParams(location.search);
  const missed = Number(q.get('missed') ?? 0);
  const api = new FakeFriendsApi({
    people: [
      { username: 'kestrel', rel: 'friend' },
      { username: 'mox', rel: 'friend', anytime: true },
      { username: 'pixel', rel: 'none' },
      { username: 'nova', rel: 'incoming', calls: 'everyone' },
      { username: 'orbit', rel: 'blocked' },
    ],
    privacy: q.get('privacy') ? { calls: q.get('privacy') as 'nobody' } : undefined,
    missed: Array.from({ length: missed }, (_, i) => ({ from: i % 2 ? 'mox' : 'kestrel', video: i % 2 === 0, minutesAgo: 5 + i * 40 })),
    answerAfter: q.get('answer') ? Number(q.get('answer')) : undefined,
  });
  // &live=<auth URL>&tok=<access token>: the real auth service instead.
  const live = q.get('live');
  const liveApi = live ? new HttpFriendsApi({
    request: async <T,>(method: string, path: string, body?: unknown): Promise<T> => {
      const r = await fetch(live + path, { method, headers: { Authorization: `Bearer ${q.get('tok')}`, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
      const text = await r.text();
      const parsed = text ? JSON.parse(text) : null;
      if (!r.ok) throw Object.assign(new Error(parsed?.message ?? r.statusText), { code: parsed?.error, status: r.status });
      return parsed as T;
    },
  }) : null;
  const ctl = new FriendsController({
    api: liveApi ?? api, authUrl: 'https://auth.boson.chat', signedIn: () => true, me: () => NICK,
    onAccessChange: () => () => {}, voice: getVoiceController, video: getVideoController, openCall,
  });
  setFriendsController(ctl);
  ctl.start();
  (globalThis as unknown as { __friends: unknown }).__friends = { api, ctl };
  if (q.get('fpage')) setFriendsUi({ my: true, myView: q.get('fpage') === 'calls' ? 'calls' : 'friends' });
  const tab = q.get('tab');
  // (After the chat opens its channel, which a phone shows.)
  if (tab === 'friends' || tab === 'calls') setTimeout(() => setFriendsUi({ my: true, myView: tab, phone: tab }), 300);
  const ring = q.get('ring');
  if (ring) setTimeout(() => api.ring('kestrel', ring === 'video'), 600);
  const calling = q.get('calling');
  if (calling) setTimeout(() => { void ctl.call(calling, q.get('video') === '1'); }, 600);
}

// ?files=1: the network has a files host, so the composer offers uploads
// (a fake bridge; drop files on the chat to open the upload sheet).
const filesMode = q0.get('files') === '1';
function installFiles(): void {
  if (!filesMode) return;
  const json = (b: unknown) => ({ status: 200, body: JSON.stringify(b) });
  const bridge: FilesBridge = {
    discover: async (host) => ({ host, filesUrl: 'https://files.nebula.example', source: 'well-known' }),
    request: async (call) => call.path === '/v1/config'
      ? json({ enabled: true, guest_enabled: true, limits: { account: { quota_bytes: 500 * 1024 * 1024, window_seconds: 86400, max_file_bytes: 50 * 1024 * 1024 } }, retention_seconds: 30 * 86400 })
      : call.path === '/v1/me/usage' ? json({ used: 38 * 1024 * 1024, quota: 500 * 1024 * 1024, window_seconds: 86400, max_file: 50 * 1024 * 1024 }) : json({ token: 'g' }),
    beginUpload: async () => ({ id: 'u1', path: '/_boson/files/upload/u1' }),
    cancelUpload: async () => {},
    onProgress: () => () => {},
  };
  setFiles(new FilesController({ bridge, signedIn: () => true, accountToken: async () => 'jwt' }));
}

// ?brand=1: Nebula has a network theme (colours, its own accent and a
// messages-pane picture), as its boson.json / directory listing would give.
const brandMode = q0.get('brand') === '1';
function installBrand(): void {
  if (!brandMode) return;
  const store = new Map<string, string>();
  const n = new NetworkThemes({
    storage: { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => { store.set(k, v); }, removeItem: (k) => { store.delete(k); } },
    apply: (overlay) => getThemeStore().setNetworkOverlay(overlay),
  });
  setNetworkThemes(n);
  n.setListingTheme('irc.nebula.example', {
    version: 1, base: 'dark', radius: 8, font: 'system',
    colors: {
      bg: '#0d0b1a', surface: '#141127', 'surface-raised': '#1c1836', 'surface-hover': '#241f44', border: '#2e2852', 'border-soft': '#221d3f',
      fg: '#ece9ff', 'fg-2': '#b3acd9', 'fg-3': '#8a83b3', accent: '#8b7cff', 'accent-on': '#0d0b1a',
    },
    panes: { messages: { image: 'https://picsum.photos/seed/boson-nebula/1600/1000', dim: 0.8, blur: 2, position: 'center' } },
  });
  getNetworkThemes().setActive('irc.nebula.example');
}

function chatView(): void {
  // ?platform=ios|android: a phone app (no window controls).
  const platform = q0.get('platform');
  if (platform) (window as { bosonPlatform?: string }).bosonPlatform = platform;
  installFiles();
  installBrand();
  installVoice();
  installVideo();
  installFriends();
  // ?memos=1: unread memos and DMs in the bell (no toasts).
  if (q0.get('memos') === '1') for (const m of MEMOS) getMemoStore().append({ ...m });
  const session = makeSession();
  const chat = new ChatService(
    session as never,
    NICK,
    { history: { append: async () => {}, load: async () => [] } as never, scope: { userId: 'u', serverId: 's1', serverName: 'Nebula' } },
    // &order=1: small memory windows over a store that answers late (like
    // IndexedDB), so lines leave memory and come back on scroll-up.
    q0.get('order') === '1' ? { olderStore: slowOlderStore(), windows: { active: 40, tail: 20, page: 40 } } : undefined,
  );
  chat.attach();
  if (searchMode) session.emit({ Kind: 'CAP', From: 'irc', Target: NICK, Message: 'batch server-time message-tags chathistory', Args: ['ACK'], Raw: '' });
  else if (repliesMode === 'tags' || threadsMode) session.emit({ Kind: 'CAP', From: 'irc', Target: NICK, Message: 'server-time message-tags', Args: ['ACK'], Raw: '' });
  if (chanservMode) {
    const version = chanservMode === 'anope' || chanservMode === 'unreadable' ? 'UnrealIRCd-6.1.8' : chanservMode === 'atheme' ? 'solanum-1.0' : 'ergo-2.19.1';
    session.emit({ Kind: '004', From: 'irc.nebula.example', Target: NICK, Message: '', Args: ['irc.nebula.example', version], Raw: '' });
    if (chanservMode === 'anope' || chanservMode === 'unreadable') {
      session.emit({ Kind: '005', From: 'irc.nebula.example', Target: NICK, Message: '', Args: ['NETWORK=Nebula'], Raw: '' });
      session.emit({ Kind: 'NOTICE', From: 'ChanServ', Target: NICK, Message: 'Anope-2.0.20 -- build #1', Raw: '' });
    }
    if (chanservMode === 'atheme') session.emit({ Kind: '005', From: 'irc.nebula.example', Target: NICK, Message: '', Args: ['NETWORK=Libera.Chat'], Raw: '' });
    if (chanservMode !== 'guest') session.emit({ Kind: '900', From: 'irc.nebula.example', Target: NICK, Message: `You are now logged in as ${NICK}`, Args: [`${NICK}!${NICK}@nebula`, NICK, `You are now logged in as ${NICK}`], Raw: '' });
    if (chanservMode === 'offer') {
      setTimeout(() => session.emit({ Kind: 'NOTICE', From: 'ChanServ', Target: NICK, Message: 'You have been offered ownership of channel #dev. To accept, /CS TRANSFER ACCEPT #dev', Raw: '' }), 300);
    }
  }

  // Re-renders as the chat changes (MY's direct messages follow).
  const Layout = () => {
    const [, bump] = useState(0);
    useEffect(() => chat.subscribe(() => bump((n) => n + 1)), []);
    return (
    <ChatLayout
      chat={chat}
      serverName="Nebula"
      serverHost={voiceMode || filesMode || brandMode ? 'irc.nebula.example' : undefined}
      myNick={NICK}
      servers={[
        { serverId: 's1', name: 'Nebula', host: 'irc.nebula.example', engineState: 'connected' },
        { serverId: 's2', name: 'Pulsar', engineState: 'connected', unread: 4, mentions: 2 },
        { serverId: 's3', name: 'Quasar', engineState: 'connected' },
      ]}
      activeServerId="s1"
      myDms={friendsMode ? collectMyDms([{ serverId: 's1', serverName: 'Nebula', myNick: NICK, channels: chat.getState().channels }]) : undefined}
      onOpenDm={(_s, name) => chat.setActive(name)}
      // &late=1: the saved channel list's order (see the late join below).
      {...(q0.get('late') === '1' ? { defaultChannelOrder: ['#members', '#dev', '#ops'] } : {})}
      onLeaveServer={() => {}}
      onSelectServer={() => {}}
      onBrowseServers={() => {}}
      // &header=1: the server header's topic and gear, as on a real server.
      {...(q0.get('header') === '1' ? { serverDescription: 'A home for self-hosters', onOpenServerSettings: () => {} } : {})}
    />
  
    );
  };
  const layout = <Layout />;
  // &frame=1: inside the app frame, under the title bar (the phone's top bar).
  const framed = q0.get('frame') === '1' ? <ShotFrame>{layout}</ShotFrame> : layout;
  const withCalls = <>{framed}{friendsMode && <CallOverlays />}{q0.get('frame') === '1' && <Toasts />}</>;
  // Mentions and DMs elsewhere raise toasts (and the bell lists them).
  chat.setNotifier((ev) => getNotifier().notify(ev));
  startNotificationBridge({
    scope: () => [{ host: 'irc.nebula.example', serverId: 's1', serverName: 'Nebula', channels: ['#dev'] }],
    open: { friends: openFriends, calls: openCalls, voice: joinVoice },
  });
  render(
    voiceMode || filesMode || brandMode ? <AuthProvider service={makeAuth(voiceMode !== 'guest')}>{withCalls}</AuthProvider> : withCalls,
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

  // ?replies=tags|plain: replies, as Boson sends them (the IRCv3 tag where
  // the server has message-tags, `nick: "quote..." ` always) and as classic
  // clients write them (`nick: ` alone). `tags` with &search=1: replies to
  // lines older than what's loaded (fetched on their own; a click loads
  // back to them), and one whose original the server doesn't have.
  if (repliesMode) {
    const tags = repliesMode === 'tags';
    const tag = (id: string): Record<string, string> => (tags ? { '+draft/reply': id } : {});
    session.emit(pm('mox', 'anyone know why the build fails on arm?', 0.95, { msgid: 'r-b1' }));
    session.emit(pm('mox', 'also is the standup at 3 or 4?', 0.9, { msgid: 'r-b2' }));
    session.emit(pm(NICK, 'the relay build is green on staging', 0.85, { msgid: 'r-own' }));
    session.emit(pm('mox', 'anyone around?', 0.8, { msgid: 'r-b3' }));
    session.emit(pm('kestrel', 'mox: "anyone know..." it\'s libssl-dev, the arm image lacks it', 0.75, { msgid: 'r-k1', ...tag('r-b1') }));
    session.emit(pm('pixel', 'mox: here', 0.7, { msgid: 'r-p1' }));
    session.emit(pm('orbit', tags ? 'nice, shipping it tonight' : `${NICK}: nice, shipping it tonight`, 0.65, { msgid: 'r-o1', ...tag('r-own') }));
    if (tags && searchMode) {
      const old = searchHistory[searchHistory.length - 80]!;
      session.emit(pm('nova', `${old.from}: "${old.text.split(' ').slice(0, 2).join(' ')}..." still true today`, 0.6, { msgid: 'r-n1', ...tag(old.msgid) }));
      session.emit(pm('jrmu', 'that was never the plan', 0.55, { msgid: 'r-j1', ...tag('zz-gone') }));
    }
  }

  // ?reactions=1: a server with message-tags, echo-message and (unless
  // &redact=0) draft/message-redaction; we're signed in (&guest=1: not) and
  // founder of #dev (so may delete anyone's line there). Some lines carry reactions, one
  // arriving before its message and one replayed by CHATHISTORY
  // (event-playback); our own line can be deleted. &redactfail=1: the
  // server refuses deletes (FAIL REDACT).
  if (q0.get('reactions') === '1') {
    const redact = q0.get('redact') !== '0';
    const caps = ['message-tags', 'echo-message', 'batch', 'server-time', 'draft/chathistory', 'draft/event-playback', ...(redact ? ['draft/message-redaction'] : [])];
    session.emit({ Kind: 'CAP', From: 'irc', Target: NICK, Message: caps.join(' '), Args: ['ACK'], Raw: '' });
    // Signed in (Delete needs an account), unless &guest=1.
    if (q0.get('guest') !== '1') {
      session.emit({ Kind: '900', From: 'irc.nebula.example', Target: NICK, Message: `You are now logged in as ${NICK}`, Args: [`${NICK}!${NICK}@nebula`, NICK, `You are now logged in as ${NICK}`], Raw: '' });
    }
    let seq = 0;
    tagHook = (target, tags) => setTimeout(() => session.emit({
      Kind: 'TAGMSG', From: NICK, Target: target, Message: '', Raw: '',
      Tags: { ...tags, msgid: `echo-${++seq}`, time: new Date().toISOString() },
    }), 30);
    rawHook = (line) => {
      const m = /^REDACT (\S+) (\S+)/.exec(line);
      if (!m) return;
      setTimeout(() => session.emit(q0.get('redactfail') === '1'
        ? { Kind: 'FAIL', From: 'irc', Target: '', Args: ['REDACT', 'REDACT_FORBIDDEN', m[1]!, m[2]!], Message: 'You are not authorized to delete this message', Raw: '' }
        : { Kind: 'REDACT', From: NICK, Target: m[1]!, Args: [m[2]!], Message: '', Raw: '' }), 30);
    };
    const tag = (from: string, target: string, emoji: string, mAgo: number, extra: Record<string, string> = {}): IrcEvent => ({
      Kind: 'TAGMSG', From: from, Target: CHAN, Message: '', Raw: '',
      Tags: { '+draft/react': emoji, '+draft/reply': target, time: min(mAgo), msgid: `rx-${from}-${target}-${emoji}`, ...extra },
    });
    // Before its message has loaded.
    session.emit(tag('pixel', 'm-own', '🎉', 0.4));
    session.emit(pm(NICK, 'cutting the build now, shout if anything looks off', 0.5, { msgid: 'm-own' }));
    session.emit(tag('kestrel', 'm-mention', '👍', 0.9));
    session.emit(tag('mox', 'm-mention', '👍', 0.8));
    session.emit(tag(NICK, 'm-mention', '👍', 0.7));
    session.emit(tag('orbit', 'm-mention', '😂', 0.6));
    session.emit(tag('nova', 'm-own', '❤️', 0.3));
    // Replayed in a history batch.
    session.emit({ Kind: 'BATCH', From: 'irc', Target: '', Message: '', Args: ['+rx1', 'chathistory', CHAN], Raw: '' });
    session.emit({ ...tag('orbit', 'm-own', '🎉', 0.35), Tags: { ...tag('orbit', 'm-own', '🎉', 0.35).Tags, batch: 'rx1' } });
    session.emit({ Kind: 'BATCH', From: 'irc', Target: '', Message: '', Args: ['-rx1'], Raw: '' });
  }

  // ?threads=1: reply chains (with message-tags) that make threads: one
  // with replies to replies (yours among them), one with a single reply, a
  // plain `nick:` line (not a reply, no thread), and a chain whose original isn't
  // loaded (rooted at its oldest line). window.__emit (below) sends more
  // lines in (a live reply).
  if (threadsMode) {
    const r = (id: string): Record<string, string> => ({ '+draft/reply': id });
    session.emit(pm('jrmu', 'kestrel: "the relay..." agreed, and the cert renewed fine', 0.98, { msgid: 't-0b', ...r('t-gone') }));
    session.emit(pm('kestrel', 'jrmu: good, one less thing', 0.96, { msgid: 't-0c', ...r('t-0b') }));
    session.emit(pm('mox', 'anyone know why the build fails on arm?', 0.94, { msgid: 't-1' }));
    session.emit(pm('kestrel', 'mox: "anyone know..." it\'s libssl-dev, the arm image lacks it', 0.92, { msgid: 't-2', ...r('t-1') }));
    session.emit(pm('nova', 'standup moved to 4pm today', 0.9, { msgid: 't-s' }));
    session.emit(pm('mox', 'kestrel: ah, adding it to the image now', 0.88, { msgid: 't-3', ...r('t-2') }));
    session.emit(pm(NICK, 'mox: "ah, adding..." rebuild the base too, it pins the old one', 0.86, { msgid: 't-4', ...r('t-3') }));
    session.emit(pm('pixel', 'mox: "anyone know..." same on my pi, fixed by that too', 0.84, { msgid: 't-5', ...r('t-1') }));
    session.emit(pm('orbit', 'nova: "standup..." works for me', 0.82, { msgid: 't-6', ...r('t-s') }));
    session.emit(pm('pixel', 'nova: ok', 0.8, { msgid: 't-7' }));
    session.emit(pm('mox', `${NICK}: "rebuild the..." done, green on arm now`, 0.7, { msgid: 't-8', ...r('t-4') }));
    // &reactions=1 too: a reaction on the root and a reply deleted by its
    // author (both show the same in the thread panel).
    if (q0.get('reactions') === '1') {
      session.emit({ Kind: 'TAGMSG', From: 'kestrel', Target: CHAN, Message: '', Raw: '', Tags: { '+draft/react': '👍', '+draft/reply': 't-1', time: min(0.6), msgid: 'rx-t1' } });
      session.emit({ Kind: 'REDACT', From: 'pixel', Target: CHAN, Args: ['t-5'], Message: '', Raw: '' });
    }
  }

  // &scroll=N: N more lines, every third one an image from img.test (the
  // scroll-stability spec serves those, late), the last one an image too.
  const scrollLines = Number(q0.get('scroll') ?? 0);
  for (let i = 0; i < scrollLines; i++) {
    const who = ['kestrel', 'pixel', 'orbit', 'mox'][i % 4]!;
    const text = i === scrollLines - 1 || i % 3 === 1
      ? `shot ${i}: https://img.test/pic-${i}.png`
      : i % 5 === 0
        ? `line ${i}: a longer one that wraps onto a second line on most widths, about the relay build and what changed since the last cut of it`
        : `line ${i}`;
    session.emit(pm(who, text, 0.5 - i / (scrollLines * 4), { msgid: `sc-${i}` }));
  }
  // &tall=N: N pasted multi-line blocks (markdown documents, one line per
  // PRIVMSG) between short lines, far taller than the average row: a list
  // that guesses unmeasured rows' heights has the most to correct here.
  const tallBlocks = Number(q0.get('tall') ?? 0);
  for (let b = 0; b < tallBlocks; b++) {
    const who = ['kestrel', 'pixel', 'orbit', 'mox'][b % 4]!;
    const at = 600 - b * 10; // minutes ago, oldest first
    session.emit(pm('nova', `short ${b}`, at + 2, { msgid: `ts-${b}` }));
    const n = 4 + (b % 5) * 3;
    const lines = [`## Notes ${b}`, ...Array.from({ length: n }, (_, j) => `- point ${j} of block ${b}, with enough words to wrap on a phone`)];
    lines.forEach((l, j) => session.emit(pm(who, l, at - j / 60, { msgid: `tb-${b}-${j}` })));
  }

  // &evplay=1: an Ergo with event-playback. Joins and quits seen live, then
  // the channel's history replaying them (and older ones) as real events,
  // plus HistServ's stand-ins a server without event-playback sends: one
  // set of rows, no HistServ, no duplicates.
  if (q0.get('evplay') === '1') {
    session.emit({ Kind: 'CAP', From: 'irc', Target: NICK, Message: 'batch server-time message-tags chathistory draft/event-playback', Args: ['ACK'], Raw: '' });
    const now = new Date().toISOString();
    session.emit({ Kind: 'JOIN', From: 'juno', Target: CHAN, Message: '', User: 'juno', Host: 'nebula/juno', Tags: { msgid: 'ev-live-j', time: now }, Raw: '' });
    session.emit({ Kind: 'QUIT', From: 'orbit', Target: '', Message: 'Quit: shutting down', Raw: '' });
    const ev = (Kind: string, From: string, mAgo: number, msgid: string, extra: Partial<IrcEvent> = {}): IrcEvent =>
      ({ Kind, From, Target: CHAN, Message: '', Tags: { batch: 'evh', msgid, time: mAgo === 0 ? now : min(mAgo) }, Raw: '', ...extra });
    session.emit({ Kind: 'BATCH', From: 'irc', Target: '', Message: '', Args: ['+evh', 'chathistory', CHAN], Raw: '' });
    for (const e of [
      ev('JOIN', 'mox', 2.6, 'ev-1'),
      ev('JOIN', 'pixel', 2.5, 'ev-2'),
      ev('QUIT', 'quasar', 2.4, 'ev-3', { Target: '', Message: 'Quit: shutting down' }),
      ev('PRIVMSG', 'HistServ', 2.35, '_ev-4', { Message: 'TheLion-windows [account: TheLion-windows] joined the channel' }),
      ev('PRIVMSG', 'HistServ', 2.3, '_ev-5', { Message: 'quasar quit (Quit: shutting down)' }),
      ev('TAGMSG', 'pixel', 2.2, 'ev-6', { Tags: { batch: 'evh', '+typing': 'active', time: min(2.2) } }),
      ev('NICK', 'mox', 2.1, 'ev-7', { Target: '', Message: 'mox_' }),
      ev('JOIN', 'juno', 0, 'ev-live-j'),
      ev('QUIT', 'orbit', 0, 'ev-q-orbit', { Target: '', Message: 'Quit: shutting down' }),
    ]) session.emit(e);
    session.emit({ Kind: 'BATCH', From: 'irc', Target: '', Message: '', Args: ['-evh'], Raw: '' });
  }

  // Friends: a couple of direct messages (MY lists them).
  if (friendsMode) {
    session.emit({ Kind: 'PRIVMSG', From: 'mox', Target: NICK, Message: 'pairing on the relay later?', Tags: { time: min(20) }, Raw: '' });
    session.emit({ Kind: 'PRIVMSG', From: 'kestrel', Target: NICK, Message: 'the relay test passed', Tags: { time: min(4) }, Raw: '' });
    // A service conversation (the user /msg'd NickServ): not a person, so not in MY.
    chat.openDM('NickServ');
  }
  chat.setActive(CHAN);
  if (q0.get('order') === '1') orderScenario(chat, session.emit);
  // &late=1: #members is saved first but only lets registered users in, so
  // it's refused until NickServ has identified us and joins after #ops.
  if (q0.get('late') === '1') {
    chat.join('#members', { focus: false });
    session.emit({ Kind: '477', From: 'irc', Target: NICK, Message: 'You need to be identified', Args: ['#members', 'x'], Raw: '' });
    session.emit({ Kind: 'JOIN', From: NICK, Target: '#ops', Message: '', Raw: '' });
    setTimeout(() => {
      chat.join('#members', { focus: false });
      session.emit({ Kind: 'JOIN', From: NICK, Target: '#members', Message: '', Raw: '' });
    }, 400);
  }
  // &chans=N: N more channels, the last of them open, so it sits below the
  // fold of the channel list.
  const extra = Number(q0.get('chans') ?? 0);
  for (let i = 1; i <= extra; i++) {
    const name = `#room-${String(i).padStart(2, '0')}`;
    session.emit({ Kind: 'JOIN', From: NICK, Target: name, Message: '', Raw: '' });
    session.emit({ Kind: '366', From: 'irc', Target: name, Message: '', Raw: '' });
    if (i === extra) chat.setActive(name);
  }
  // &notify=mention,dm,friend,accepted,missed,started,ring: those arrive
  // (after the page settles), as toasts and in the bell.
  const notify = (q0.get('notify') ?? '').split(',').filter(Boolean);
  if (notify.length) {
    setTimeout(() => {
      const f = (globalThis as unknown as { __friends?: { api: FakeFriendsApi; ctl: FriendsController } }).__friends;
      for (const n of notify) {
        if (n === 'mention') {
          session.emit({ Kind: 'JOIN', From: NICK, Target: '#ops', Message: '', Raw: '' });
          session.emit({ Kind: 'PRIVMSG', From: 'kestrel', Target: '#ops', Message: `${NICK}: the relay test passed, want to look?`, Tags: { time: min(0) }, Raw: '' });
          chat.setActive(CHAN);
        }
        if (n === 'dm') session.emit({ Kind: 'PRIVMSG', From: 'mox', Target: NICK, Message: 'are you around for a call in 10?', Tags: { time: min(0) }, Raw: '' });
        if (n === 'friend') f?.api.requestFrom('juno');
        if (n === 'accepted') f?.api.acceptedBy('pixel');
        if (n === 'missed' && f) { const c = f.api.ring('kestrel', true); setTimeout(() => f.api.missRing(c.id), 200); }
        if (n === 'ring') f?.api.ring('kestrel', true);
        if (n === 'started') {
          getNotificationFeed().toast({ kind: 'started', title: 'Call started', where: 'General · Nebula', body: 'nova, kestrel and pixel are in General', nick: 'nova', room: { host: 'irc.nebula.example', roomId: 'general', name: 'General', serverName: 'Nebula' } });
        }
      }
    }, 900);
  }
  // Expose the emitter so the screenshot driver can inject extra events (e.g.
  // finalize an empty ban list when the Channel Settings modal is open).
  (window as W & { __emit?: (e: IrcEvent) => void }).__emit = (e) => session.emit(e);
  // Let images/cards load, then pin to the newest message for the shot.
  const pin = (): void => {
    const el = document.querySelector('.chat-messages');
    if (el) el.scrollTop = el.scrollHeight;
  };
  // (Not with &scroll=: those specs scroll it themselves, and the list
  // keeps itself at the bottom.)
  if (!scrollLines) {
    setTimeout(pin, 400);
    setTimeout(pin, 1200);
  }
}

// An OlderStore whose pages arrive 300 ms late, like IndexedDB's.
function slowOlderStore(): MemoryOlderStore {
  const store = new MemoryOlderStore();
  const take = store.takeNewest.bind(store);
  (store as { takeNewest: (k: string, n: number) => unknown }).takeNewest = (k: string, n: number) =>
    new Promise((res) => setTimeout(() => res(take(k, n)), 300));
  return store;
}

// &order=1: the ordering bug seen through evrd. #dev's older lines
// ("It's now automated", "cool" and the talk after them) have left memory;
// the user steps away to #ops and back, and while the window refills from
// the store, the reconnect's backlog lands with a line this device never
// got, older than all of them ("test"). It belongs at the top, not under
// lines that come back from the store. window.__late(text, minutesAgo)
// sends another late line later (the spec, scrolled up).
function orderScenario(chat: ChatService, emit: (e: IrcEvent) => void): void {
  emit({ Kind: 'CAP', From: 'irc', Target: NICK, Message: 'batch server-time', Args: ['ACK'], Raw: '' });
  chat.setForeground(true);
  const now = Date.now(); // one clock: a replayed line has the same time
  const at = (mAgo: number) => new Date(now - mAgo * 60_000).toISOString();
  const say = (from: string, text: string, mAgo: number, batch?: string): void =>
    emit({ Kind: 'PRIVMSG', From: from, Target: CHAN, Message: text, Tags: { time: at(mAgo), ...(batch ? { batch } : {}) }, Raw: '' });
  say(NICK, "It's now automated. I have it flag accounts", 120);
  say('jrmu', 'cool', 100);
  for (let i = 0; i < 60; i++) say(['kestrel', 'pixel', 'orbit', 'mox'][i % 4]!, `earlier talk ${i}`, 90 - i);
  emit({ Kind: 'JOIN', From: NICK, Target: '#ops', Message: '', Raw: '' });
  chat.setActive('#ops');
  chat.setActive(CHAN);
  emit({ Kind: 'BATCH', From: 'irc', Target: '', Message: '', Args: ['+late', 'chathistory', CHAN], Raw: '' });
  say(NICK, 'test', 130, 'late');
  say('jrmu', 'cool', 100, 'late');
  emit({ Kind: 'BATCH', From: 'irc', Target: '', Message: '', Args: ['-late'], Raw: '' });
  (window as unknown as { __late?: (text: string, mAgo: number) => void }).__late = (text, mAgo) => say(NICK, text, mAgo);
}

// The app frame for &frame=1: the title bar (bell, avatar) above the layout,
// the bell's list, and the memos it holds (?memos=1).
function ShotFrame({ children }: { children: preact.ComponentChildren }) {
  const [open, setOpen] = useState(q0.get('bell') === '1');
  const unread = useUnreadNotes();
  const narrow = useNarrow();
  useEffect(() => {
    setNotificationsOpener(() => setOpen(true));
    return () => setNotificationsOpener(null);
  }, []);
  return (
    <div class="app-frame">
      <TitleBar userLabel={q0.get('fed') === '1' ? 'alice-bosonchat' : NICK} userMode="account" onOpenSettings={() => {}}
        userHomeDomain={q0.get('fed') === '1' ? 'boson.chat' : null}
        onOpenNotifications={() => setOpen((o) => !o)} notificationsCount={unread} notificationsOpen={open} />
      <div class="app-frame-body">{children}</div>
      {open && <NotificationsPanel layout={narrow || q0.get('platform') ? 'phone' : 'desktop'} onClose={() => setOpen(false)} onOpenSettings={() => {}} />}
    </div>
  );
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
  // ?fed=1: signed in to a self-hosted network with a boson.chat account
  // (federated: no email here, alice@boson.chat vouched for by boson.chat).
  const federated = q0.get('fed') === '1';
  const session = signedIn
    ? federated
      ? {
        access_token: 'jwt', expires_at: Date.now() + 900_000, refresh_token: 'r', session_id: 'ses_1',
        user: { id: 'usr_1', username: 'alice-bosonchat', email: null, email_verified: true, role: 'user', user_metadata: { handle: 'alice-bosonchat' } },
        federated: { identity: 'alice@boson.chat', handle: 'alice-bosonchat', homeAuthUrl: 'https://auth.boson.chat', homeDomain: 'boson.chat' },
      }
      : { access_token: 'jwt', expires_at: Date.now() + 900_000, refresh_token: 'r', session_id: 'ses_1', user: { id: 'usr_1', username: 'ada', email: 'ada@example.com', email_verified: true, role: 'user', user_metadata: { handle: 'ada' } } }
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
    config: async () => ({
      ...(new URLSearchParams(location.search).get('policy') ? { channel_auto_register: true, channel_expiry_days: 30 } : {}),
      sso_providers: [
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

// ---- Multi-directory: the main directory plus a user-added one ----
const MAIN_NETWORKS: FakeNetwork[] = [
  ...SERVERS.map((s) => ({ ...s, id: `net_${s.id}`, status: 'verified' as const, languages: ['en'], created_at: s.registered_at })),
  ...Array.from({ length: 30 }, (_, i) => ({
    id: `net_x${i}`, hostname: `irc.community${i}.example`, name: `Community ${i + 1}`,
    description: 'A small network for friends of friends.', tags: ['community'], languages: i % 3 ? ['en'] : ['de'],
    user_count: 40 - i, created_at: '2026-03-01T00:00:00Z',
  })),
];
const PEER_NETWORKS: FakeNetwork[] = [
  { id: 'net_h1', hostname: 'irc.helix.example', name: 'Helix', description: 'A friendly community for self-hosters, devs, and tinkerers.', tags: ['community', 'tech'], languages: ['en'], user_count: 412 },
  { id: 'net_h2', hostname: 'irc.hacklab.example', name: 'Hacklab Helsinki', description: 'Hardware, soldering nights and the occasional sauna.', tags: ['hardware', 'makers'], languages: ['fi', 'en'], user_count: 57, icon_url: 'https://picsum.photos/seed/hacklab/72/72' },
  { id: 'net_h3', hostname: 'irc.kahvi.example', name: 'Kahvi', description: 'Suomenkielinen yleiskanava.', tags: ['general'], languages: ['fi'], user_count: 31 },
];

function multiDirectoryNetworks(): NetworkDirectories {
  const transport = fakeTransport([
    fakeDirectory('https://directory.boson.chat', 'Boson Network Directory', MAIN_NETWORKS, { operator: 'boson.chat' }),
    fakeDirectory('https://directory.hacklab.example', 'Hacklab Directory', PEER_NETWORKS, { operator: 'Hacklab ry', authIssuer: 'https://auth.boson.chat' }),
  ], { user: 'usr_1' });
  const storage = new Map<string, string>();
  const sources = configureDirectorySources({
    transport, authUrl: 'https://auth.boson.chat',
    storage: { getItem: (k) => storage.get(k) ?? null, setItem: (k, v) => { storage.set(k, v); } },
  });
  void sources.refreshDefault();
  if (new URLSearchParams(location.search).get('peer') !== '0') void sources.add('directory.hacklab.example');
  return new NetworkDirectories(sources, { getToken: async () => 'jwt' }, transport, async () => []);
}

function multiDirView(): void {
  installApi(true);
  const networks = multiDirectoryNetworks();
  render(
    <AuthProvider service={makeAuth(true)}>
      <DirectoryScreen directory={directoryService()} networks={networks} engine={null} identity={makeIdentity()} />
    </AuthProvider>,
    app(),
  );
}

function directoryView(): void {
  installApi(true);
  // ?platform=ios|android: a phone app; &frame=1: inside the app frame.
  const platform = q0.get('platform');
  if (platform) (window as { bosonPlatform?: string }).bosonPlatform = platform;
  const screen = <DirectoryScreen directory={directoryService()} engine={null} identity={makeIdentity()} />;
  render(
    <AuthProvider service={makeAuth(true)}>
      {q0.get('frame') === '1' ? <ShotFrame>{screen}</ShotFrame> : screen}
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
  multiDirectoryNetworks();
  installVoice();
  installFriends();
  // Settings → Voice's quality card: ?platform=ios (a phone), ?metered=1
  // (on mobile data), ?vq=music&cq=high&ds=always (the settings).
  const q = new URLSearchParams(location.search);
  const platform = q.get('platform');
  if (platform) (window as { bosonPlatform?: string }).bosonPlatform = platform;
  if (q.get('vq') || q.get('cq') || q.get('ds')) {
    setVoiceSettings({
      ...(q.get('vq') ? { voiceQuality: q.get('vq') as 'standard' } : {}),
      ...(q.get('cq') ? { cameraQuality: q.get('cq') as 'auto' } : {}),
      ...(q.get('ds') ? { dataSaver: q.get('ds') as 'auto' } : {}),
    });
  }
  // ?images=1: the shell's image cache (Content → Keep up to …).
  if (q.get('images')) {
    let limitBytes = 500 * 1048576;
    const stats = async () => ({ usedBytes: 182 * 1048576, limitBytes, entries: 412 });
    (window as { bosonImages?: unknown }).bosonImages = {
      route: '/img', stats, clear: stats,
      setLimitMB: async (mb: number) => { limitBytes = mb * 1048576; return stats(); },
    };
  }
  const vstate: VideoState = { ...EMPTY_VIDEO_STATE, metered: q.get('metered') === '1' };
  setVideoController(new VideoController({
    state: async () => vstate, onState: () => () => {}, subscribe: async () => {}, unsubscribe: async () => {},
    cameras: async () => [], screenSources: async () => [], setCamera: async () => vstate, setScreen: async () => vstate,
    setCameraQuality: async () => vstate,
  }));
  // ?mode=guest: a guest (Profile is the nick); ?mode=signedout: the login
  // screen's settings (Appearance and About only).
  const mode = q.get('mode');
  if (mode === 'guest') saveGuestSession({ nick: 'ada_guest' });
  else clearGuestSession();
  render(
    <AuthProvider service={makeAuth(mode !== 'guest' && mode !== 'signedout')}>
      <UserSettings
        open
        onClose={() => {}}
        signedOut={mode === 'signedout'}
        authedHandle={mode ? null : q.get('fed') === '1' ? 'alice-bosonchat' : 'ada'}
        authedEmail={mode || q.get('fed') === '1' ? null : 'ada@example.com'}
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
  for (const m of MEMOS) getMemoStore().append({ ...m });
  render(<NotificationsPanel layout="desktop" onClose={() => {}} />, app());
}

// ?owner=1: you own the listing (Edit and Operators show); ?nettheme=1:
// the network has a theme (Appearance shows); ?section=<id> opens a section.
function servicesView(): void {
  const q = new URLSearchParams(location.search);
  const owner = q.get('owner') === '1';
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
      initialSection={q.get('section')}
      connectionState="connected"
      isOper={owner}
      directoryEntry={owner ? {
        serverId: 's1', name: 'Nebula', description: 'A friendly network for self-hosters.',
        tags: ['selfhosting', 'linux'], languages: ['en'], isNsfw: false,
      } : undefined}
      onSaveProfile={owner ? async () => {} : undefined}
      networkTheme={q.get('nettheme') === '1' ? { enabled: true, globallyEnabled: true, onToggle: () => {} } : undefined}
    />,
    app(),
  );
}

// "Sign in to <network>" on a network that takes accounts from other Boson
// servers: "Continue as …" for the boson.chat account and a second home
// account above the network's own sign-in. ?fail=<code>: the remote
// refuses with that code (spec §3) after a tap; ?homes=1: only boson.chat.
async function netSignInView(): Promise<void> {
  const q = new URLSearchParams(location.search);
  const fail = q.get('fail');
  const fed = (domain: string, accepts = 'directory') => ({
    version: 1, issuer: `https://auth.${domain}`, accepts, domain,
    assertion_endpoint: `https://auth.${domain}/v1/federation/assertions`,
    login_endpoint: `https://auth.${domain}/v1/federation/login`,
  });
  const json = (status: number, v: unknown) => ({ status, ok: status < 300, statusText: String(status), text: JSON.stringify(v) });
  const transport = async (req: { url: string; body?: unknown }) => {
    const u = new URL(req.url);
    const user = (username: string, extra = {}) => json(200, {
      access_token: 'h.e30.s', expires_in: 900, refresh_token: `rt-${u.host}`, session_id: 's',
      user: { id: `u-${u.host}`, username, email: null, email_verified: true, role: 'user' }, ...extra,
    });
    if (u.pathname === '/v1/config') return json(200, { registration: 'open', sso_providers: [], site_name: 'Hexbay', guest_access: true });
    if (u.pathname === '/v1/login') return user(u.host.includes('fediverse') ? 'ada_l' : 'ada');
    if (u.pathname === '/v1/federation/assertions') return json(200, { assertion: 'jwt', expires_in: 300 });
    if (u.pathname === '/v1/federation/login') {
      if (fail) return json(403, { error: fail, message: 'refused' });
      return new Promise(() => {});
    }
    return json(404, {});
  };
  const storage = new InMemorySecureStorage();
  const mainAuth = new AuthService('https://auth.boson.chat', { storage, transport: transport as never });
  const accounts = new NetworkAccounts({
    mainAuthUrl: 'https://auth.boson.chat', mainAuth, storage, transport: transport as never,
    local: null,
    bridge: {
      discover: async (host: string) => {
        if (host === 'boson.chat') return { host, main: true, authUrl: 'https://auth.boson.chat', federation: fed('boson.chat') };
        if (host === 'irc.fediverse.party') return { host, main: false, authUrl: 'https://auth.fediverse.party', federation: fed('fediverse.party', 'open') };
        return { host, main: false, authUrl: 'https://auth.hexbay.net', federation: fed('hexbay.net') };
      },
    },
  });
  await mainAuth.signIn('ada', 'pw');
  if (q.get('homes') !== '1') {
    await accounts.discover('irc.fediverse.party');
    await accounts.service('https://auth.fediverse.party').signIn('ada_l', 'pw');
  }
  const link = (await accounts.discover('irc.hexbay.net'))!;
  void accounts.promptSignIn({ link, serverName: 'Hexbay', reason: 'connect', allowGuest: true });
  render(<NetworkSignInHost accounts={accounts} />, app());
}


// The sign-in screen of a network with its own look and sign-up rules (a
// self-hosted network's web client, like chat.boson.ircforever.org).
// ?theme=1: the network has a theme (dark, accent #70d199, a light
// variant); ?registration=open|invite|closed; ?selfhosted=1: the home
// network is IRCForever and takes accounts from other Boson servers
// ("Continue with boson.chat"); &homes=1: a boson.chat account is already
// signed in here ("Continue as ada@boson.chat"). ?light=1: the app's light
// mode.
async function signInView(): Promise<void> {
  const q = new URLSearchParams(location.search);
  const registration = q.get('registration') ?? 'open';
  if (q.get('light') === '1') getThemeStore().setActive('daylight');
  // Served at the auth service's /v1/branding, as its /v1/config says.
  const themeDoc = q.get('theme') === '1' ? {
    version: 1, base: 'dark', font: 'system',
    colors: {
      bg: '#0b1410', surface: '#101c17', 'surface-raised': '#16251e', 'surface-hover': '#1c2e26', border: '#2a4237', 'border-soft': '#1f3329',
      fg: '#e6f2ec', 'fg-2': '#b2c7bd', 'fg-3': '#86a094', accent: '#70d199', 'accent-on': '#06110b',
    },
    variants: {
      light: {
        colors: {
          bg: '#f6fbf8', surface: '#ffffff', 'surface-raised': '#ffffff', 'surface-hover': '#eaf4ee', border: '#c9dcd1', 'border-soft': '#dde9e2',
          fg: '#0d1a13', 'fg-2': '#3a5246', 'fg-3': '#5d7468', accent: '#1f8a52', 'accent-on': '#ffffff',
        },
      },
    },
  } : null;
  const mem = new Map<string, string>();
  const themes = new NetworkThemes({
    storage: { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => { mem.set(k, v); }, removeItem: (k) => { mem.delete(k); } },
    bridge: null,
    fetch: (async (url: string) => (themeDoc && String(url).endsWith('/v1/branding')
      ? new Response(JSON.stringify(themeDoc), { status: 200, headers: { 'Content-Type': 'application/json' } })
      : new Response('', { status: 404 }))) as typeof fetch,
    apply: (overlay) => getThemeStore().setNetworkOverlay(overlay),
  });
  setNetworkThemes(themes);
  const selfHosted = q.get('selfhosted') === '1';
  const mainUrl = selfHosted ? 'https://auth.boson.ircforever.org' : 'https://auth.boson.chat';
  const homeDomain = new URL(mainUrl).hostname.replace(/^auth\./, '');
  if (selfHosted) {
    setHomeNetwork({ domain: homeDomain, name: 'IRCForever', selfHosted: true, irc: { host: 'irc.boson.ircforever.org', port: 6697, tls: true } });
  }
  const cfg = {
    registration, sso_providers: [], guest_access: true,
    ...(selfHosted ? { network_name: 'IRCForever' } : {}),
    ...(themeDoc ? { branding_url: `${mainUrl}/v1/branding` } : {}),
  };
  const json = (status: number, v: unknown) => ({ status, ok: status < 300, statusText: String(status), text: JSON.stringify(v) });
  const transport = async (req: { url: string }) => {
    const u = new URL(req.url);
    if (u.pathname === '/v1/config') return json(200, u.host === 'auth.boson.chat' && selfHosted ? { registration: 'open', sso_providers: [], site_name: 'boson.chat' } : cfg);
    if (u.pathname === '/v1/login') return json(200, {
      access_token: 'h.e30.s', expires_in: 900, refresh_token: `rt-${u.host}`, session_id: 's',
      user: { id: `u-${u.host}`, username: 'ada', email: null, email_verified: true, role: 'user' },
    });
    return json(404, {});
  };
  const storage = new InMemorySecureStorage();
  const fed = (domain: string) => ({
    version: 1, issuer: `https://auth.${domain}`, accepts: 'directory', domain,
    assertion_endpoint: `https://auth.${domain}/v1/federation/assertions`,
    login_endpoint: `https://auth.${domain}/v1/federation/login`,
  });
  const mainAuth = new AuthService(mainUrl, { storage, transport: transport as never });
  const accounts = selfHosted
    ? new NetworkAccounts({
      mainAuthUrl: mainUrl, mainAuth, storage, transport: transport as never, local: null,
      bridge: {
        discover: async (host: string) => (host === 'auth.boson.ircforever.org' || host === 'irc.boson.ircforever.org'
          ? { host, main: true, authUrl: mainUrl, federation: fed(homeDomain) }
          : { host, main: false, authUrl: 'https://auth.boson.chat', federation: fed('boson.chat') }),
        resolve: async (address: string) => ({ host: address, domain: 'boson.chat', irc: { host: 'irc.boson.chat', port: 6697, tls: true }, authUrl: 'https://auth.boson.chat', main: false, federation: fed('boson.chat') }),
      },
    })
    : null;
  if (accounts && q.get('homes') === '1') {
    await accounts.discover('irc.boson.chat');
    await accounts.service('https://auth.boson.chat').signIn('ada', 'pw');
  }
  render(
    <AuthProvider service={mainAuth}>
      <LoginScreen directory={directoryService()} identity={makeIdentity()} accounts={accounts} />
    </AuthProvider>,
    app(),
  );
}

// The whole app on a self-hosted web client (IRCForever), boson.chat signed
// in here: "Continue as ada@boson.chat" goes straight into the app (no
// identity key step); the profile comes from boson.chat. window.__askKey(reason)
// stands in for something that needs the key later (saving a NickServ
// password that syncs).
async function fedFlowView(): Promise<void> {
  const q = new URLSearchParams(location.search);
  const remoteAuth = 'https://auth.boson.ircforever.org';
  setHomeNetwork({ domain: 'boson.ircforever.org', name: 'IRCForever', selfHosted: true, irc: { host: 'irc.boson.ircforever.org', port: 6697, tls: true } });
  const json = (status: number, v: unknown) => ({ status, ok: status < 300, statusText: String(status), text: JSON.stringify(v) });
  const homeBlob = await new IdentityService((pw, salt) => {
    const out = new Uint8Array(32);
    for (let i = 0; i < 32; i++) out[i] = (pw.charCodeAt(i % Math.max(pw.length, 1)) + salt[i]!) & 0xff;
    return out;
  }, new InMemorySecureStorage()).initializeForNewUser('correct horse battery');
  const tokens = (host: string, username: string, extra = {}) => json(200, {
    access_token: `h.e30.${host}`, expires_in: 900, refresh_token: `rt-${host}`, session_id: 's',
    user: { id: `u-${host}`, username, email: null, email_verified: true, role: 'user' }, ...extra,
  });
  const transport = async (req: { method: string; url: string }) => {
    const u = new URL(req.url);
    if (u.host === 'api.boson.chat') {
      if (u.pathname === '/me') return q.get('nokey') === '1' ? json(404, { status: 'needs_setup' }) : json(200, { ...USER, handle: 'ada', encrypted_user_secret: homeBlob });
      if (u.pathname === '/me/session') return json(200, { payload: null });
      return json(200, {});
    }
    if (u.host === 'api.boson.ircforever.org') {
      if (u.pathname === '/servers') return json(200, { servers: SERVERS, count: SERVERS.length });
      if (u.pathname === '/servers/me') return json(200, { servers: [], count: 0 });
      return json(404, {});
    }
    if (u.pathname === '/v1/config') return json(200, u.host === 'auth.boson.chat' ? { registration: 'open', sso_providers: [], site_name: 'boson.chat' } : { registration: 'closed', sso_providers: [], network_name: 'IRCForever', guest_access: true });
    if (u.pathname === '/v1/login') return tokens(u.host, 'ada');
    if (u.pathname === '/v1/federation/assertions') return json(200, { assertion: 'jwt', expires_in: 300 });
    if (u.pathname === '/v1/federation/login') return tokens(u.host, 'ada-bosonchat', { federated: true, identity: 'ada@boson.chat', handle: 'ada-bosonchat' });
    return json(404, {});
  };
  const fed = (domain: string) => ({
    version: 1, issuer: `https://auth.${domain}`, accepts: 'directory', domain,
    assertion_endpoint: `https://auth.${domain}/v1/federation/assertions`,
    login_endpoint: `https://auth.${domain}/v1/federation/login`,
  });
  const storage = new InMemorySecureStorage();
  const auth = new AuthService(remoteAuth, { storage, transport: transport as never });
  const accounts = new NetworkAccounts({
    mainAuthUrl: remoteAuth, mainAuth: auth, storage, transport: transport as never, local: null,
    bridge: {
      discover: async (host: string) => (host.endsWith('ircforever.org')
        ? { host, main: true, authUrl: remoteAuth, federation: fed('boson.ircforever.org') }
        : { host, main: false, authUrl: 'https://auth.boson.chat', federation: fed('boson.chat') }),
    },
  });
  setNetworkAccounts(accounts);
  setHomeAuthSource(accounts);
  await auth.init();
  await accounts.discover('irc.boson.chat');
  await accounts.service('https://auth.boson.chat').signIn('ada', 'pw');
  const directory = new AccountDirectory(new HttpClient('https://api.boson.ircforever.org', { getToken: () => auth.getToken() }, transport as never), auth, new HomeAccountData(auth, { transport: transport as never }));
  const identity = makeIdentity();
  (window as { __askKey?: (r: string) => Promise<boolean> }).__askKey = (r) => requestIdentityKey(identity, r as never);
  render(<App auth={auth} directory={directory} engine={null} identity={identity} history={{} as never} homeData={directory.homeData} />, app());
}

// "Continue with IRCForever" (SSO) on a self-hosted web client (the whole
// app): straight into the app, no identity key step. ?new=1: an account
// the sign-in just made (its handle step); else an existing one whose key
// a password wraps, asked for later (window.__askKey).
async function ssoFlowView(): Promise<void> {
  const q = new URLSearchParams(location.search);
  const authUrl = 'https://auth.boson.ircforever.org';
  setHomeNetwork({ domain: 'boson.ircforever.org', name: 'IRCForever', selfHosted: true, irc: { host: 'irc.boson.ircforever.org', port: 6697, tls: true } });
  const json = (status: number, v: unknown) => ({ status, ok: status < 300, statusText: String(status), text: JSON.stringify(v) });
  const blob = await new IdentityService((pw, salt) => {
    const out = new Uint8Array(32);
    for (let i = 0; i < 32; i++) out[i] = (pw.charCodeAt(i % Math.max(pw.length, 1)) + salt[i]!) & 0xff;
    return out;
  }, new InMemorySecureStorage()).initializeForNewUser('admin password');
  let me: Record<string, unknown> | null = q.get('new') === '1' ? null : { ...USER, id: 'u-admin', handle: 'admin', encrypted_user_secret: blob };
  const transport = async (req: { method: string; url: string; body?: unknown }) => {
    const u = new URL(req.url);
    if (u.host === 'api.boson.ircforever.org') {
      if (u.pathname === '/me' && req.method === 'POST') {
        const b = JSON.parse(String(req.body ?? '{}')) as Record<string, unknown>;
        me = { ...USER, id: 'u-admin', handle: b['handle'], encrypted_user_secret: b['encrypted_user_secret'] ?? '' };
        return json(201, me);
      }
      if (u.pathname === '/me') return me ? json(200, me) : json(404, { status: 'needs_setup' });
      if (u.pathname === '/me/session') return json(200, { payload: null });
      if (u.pathname === '/servers') return json(200, { servers: SERVERS, count: SERVERS.length });
      if (u.pathname === '/servers/me') return json(200, { servers: [], count: 0 });
      return json(200, {});
    }
    if (u.pathname === '/v1/config') {
      return json(200, { registration: 'closed', network_name: 'IRCForever', sso_providers: [{ slug: 'ircforever', kind: 'oidc', display_name: 'IRCForever', start_url: `${authUrl}/v1/sso/ircforever/start` }] });
    }
    if (u.pathname === '/v1/sso/exchange') {
      return json(200, {
        access_token: 'h.e30.sso', expires_in: 900, refresh_token: 'rt-sso', session_id: 's',
        user: { id: 'u-admin', username: 'admin', email: 'admin@ircforever.org', email_verified: true, role: 'user' },
      });
    }
    return json(404, {});
  };
  (window as W & { bosonSSO?: unknown }).bosonSSO = {
    begin: async () => ({ id: 'f1', redirectUri: `${location.origin}/sso/callback?s=f1` }),
    wait: async () => ({ code: 'bsc_1' }),
    cancel: async () => {},
    open: async () => {},
  };
  const storage = new InMemorySecureStorage();
  const auth = new AuthService(authUrl, { storage, transport: transport as never });
  await auth.init();
  const directory = new AccountDirectory(new HttpClient('https://api.boson.ircforever.org', { getToken: () => auth.getToken() }, transport as never), auth);
  const identity = makeIdentity();
  (window as { __askKey?: (r: string) => Promise<boolean> }).__askKey = (r) => requestIdentityKey(identity, r as never);
  render(<App auth={auth} directory={directory} engine={null} identity={identity} history={{} as never} homeData={directory.homeData} />, app());
}

const view = new URLSearchParams(location.search).get('view') ?? 'chat';
if (view === 'chat') chatView();
else if (view === 'directory') directoryView();
else if (view === 'multidir') multiDirView();
else if (view === 'auth') authView();
else if (view === 'settings') settingsView();
else if (view === 'services') servicesView();
else if (view === 'inbox') inboxView();
else if (view === 'netsignin') void netSignInView();
else if (view === 'signin') void signInView();
else if (view === 'fedflow') void fedFlowView();
else if (view === 'ssoflow') void ssoFlowView();
else app().textContent = `unknown view: ${view}`;
