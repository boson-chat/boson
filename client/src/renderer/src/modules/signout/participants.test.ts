// The app's sign-out list end to end, on the real stores: account A's data
// in every module, signOut(), and none of it is left for the next account.
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { __resetSignOut, signOut } from './sign-out';
import { appSignOutParticipants, registerAppSignOut } from './participants';
import { InMemorySecureStorage } from '../../shared/secure-storage';
import { SecureServiceCredentialsStore, getServiceCredentialsStore, setServiceCredentialsStore } from '../chat/services-credentials';
import { SecureBouncerStore, getBouncerStore, setBouncerStore } from '../chat/bouncer.store';
import { LocalStorageMemoStore, getMemoStore, setMemoStore } from '../memos';
import { NotificationFeed, getNotificationFeed, setNotificationFeed } from '../notifications/feed';
import { configureDirectorySources, getDirectorySources } from '../directory/sources';
import { getAvatar, setAvatar } from '../chat/avatar-cache';
import { __resetNotificationSettingsCache, getChannelLevel, getNotificationSettings, setChannelLevel, setNotificationSettings } from '../ui/notifications.store';
import { setVoiceController } from '../voice';
import { setFriendsController } from '../friends';
import { setFiles } from '../files';
import { setVideoController } from '../video';
import { setNetworkAccounts } from '../netauth/network-accounts';

const A = 'usr_alice';

function fakeAuth() {
  let session: unknown = { user: { id: A } };
  return {
    getState: () => ({ session, loading: false, error: null }) as never,
    signOut: vi.fn(async () => { session = null; }),
  };
}

function controllers() {
  const calls: string[] = [];
  const fake = (name: string) => ({ clearForSignOut: vi.fn(async () => { calls.push(name); }), dispose: () => {} });
  const voice = fake('voice');
  const video = fake('video');
  const friends = fake('friends');
  const files = fake('files');
  const net = { ...fake('network-accounts'), knownAuthUrls: () => ['https://auth.net.example'] };
  setVoiceController(voice as never);
  setVideoController(video as never);
  setFriendsController(friends as never);
  setFiles(files as never);
  setNetworkAccounts(net as never);
  return calls;
}

let secure: InMemorySecureStorage;

beforeEach(() => {
  localStorage.clear();
  secure = new InMemorySecureStorage();
  setServiceCredentialsStore(new SecureServiceCredentialsStore(secure, null, { probeIntervalMs: 1, probeTimeoutMs: 5 }));
  setBouncerStore(new SecureBouncerStore(secure, { probeIntervalMs: 1, probeTimeoutMs: 5 }));
  setMemoStore(new LocalStorageMemoStore(A));
  setNotificationFeed(new NotificationFeed());
  configureDirectorySources({ storage: localStorage });
  __resetNotificationSettingsCache();
});

afterEach(() => {
  __resetSignOut();
  setVoiceController(null);
  setVideoController(null);
  setFriendsController(null);
  setFiles(null);
  setNetworkAccounts(null);
});

describe('app sign-out participants', () => {
  it('every phase is covered and names are unique', () => {
    const list = appSignOutParticipants({ engine: null, identity: { clearStorage: async () => {} }, history: null, secure, syncs: [] });
    const names = list.map((p) => p.name);
    expect(new Set(names).size).toBe(names.length);
    expect(new Set(list.map((p) => p.phase))).toEqual(new Set(['stop', 'disconnect', 'wipe', 'storage']));
    // The storage wipe is alone in the last phase.
    expect(list.filter((p) => p.phase === 'storage').map((p) => p.name)).toEqual(['storage']);
  });

  it("leaves nothing of account A behind and keeps the device's preferences", async () => {
    const calls = controllers();
    // ---- A's data everywhere ----
    await getServiceCredentialsStore().whenHydrated?.();
    getServiceCredentialsStore().set('libera', { nickservPassword: 'hunter2', accountName: 'alice' });
    await getBouncerStore().whenHydrated();
    getBouncerStore().set({ enabled: true, host: 'znc.example', port: 7000, tls: true, tlsInsecure: false, username: 'alice', password: 'zncpw' } as never);
    getMemoStore().append({ serverId: 's1', serverName: 'Libera', sender: 'bob', kind: 'dm', text: 'secret dm', timestamp: 1 } as never);
    getNotificationFeed().setUserId(A);
    getNotificationFeed().add({ id: 'f1', kind: 'friend', sub: 'request', title: 'bob', where: '', body: 'wants to be friends', nick: 'bob' });
    getNotificationFeed().toast({ kind: 'dm', title: 'bob', body: 'hi' } as never);
    setAvatar('s1', 'bob', 'https://img.example/bob.png');
    setChannelLevel('s1', '#private', 'all');
    setNotificationSettings({ sound: false });
    localStorage.setItem('boson:session:v2', JSON.stringify({ servers: [], activeServerId: null }));
    localStorage.setItem('boson:local-servers:v1', '[]');
    localStorage.setItem('boson:theme:v1', '{"active":"midnight"}');
    localStorage.setItem('boson:voice:v1', '{"inputDevice":"mic-2"}');
    await secure.set('boson.auth.session', 'tokens');
    await secure.set(`boson.identity.${A}`, 'wrapped-secret');
    await secure.set('boson.netauth.session:https://auth.net.example', 'net tokens');
    const engine = { clearForSignOut: vi.fn(async () => { calls.push('engine'); }) };
    const history = { wipeAllForUser: vi.fn(async () => {}) };
    const identity = { clearStorage: vi.fn(async () => {}) };
    const syncs = [{ clearForSignOut: vi.fn() }];
    registerAppSignOut({ engine: engine as never, identity, history: history as never, secure, syncs });

    const auth = fakeAuth();
    const { failed } = await signOut({ auth, identity: { lock: vi.fn() } });
    expect(failed).toEqual([]);

    // Connections, calls, uploads and network accounts ended.
    expect(calls.sort()).toEqual(['engine', 'files', 'friends', 'network-accounts', 'video', 'voice']);
    expect(syncs[0]!.clearForSignOut).toHaveBeenCalled();
    expect(auth.signOut).toHaveBeenCalled();
    expect(history.wipeAllForUser).toHaveBeenCalledWith(A);
    expect(identity.clearStorage).toHaveBeenCalledWith(A);
    // In-memory stores reset.
    expect(getServiceCredentialsStore().get('libera')).toBeNull();
    expect(getBouncerStore().get()).toBeNull();
    expect(getMemoStore().list()).toEqual([]);
    expect(getNotificationFeed().getSnapshot()).toEqual({ toasts: [], items: [] });
    expect(getAvatar('s1', 'bob')).toBeUndefined();
    expect(getChannelLevel('s1', '#private')).toBe('mentions');
    expect(getDirectorySources().list().map((s) => s.isDefault)).toEqual([true]);
    // Storage: only device preferences remain.
    expect(secure.keys()).toEqual([]);
    const left = Array.from({ length: localStorage.length }, (_, i) => localStorage.key(i)!).sort();
    expect(left).toEqual(['boson:notifications:v1', 'boson:theme:v1', 'boson:voice:v1']);
    expect(getNotificationSettings().sound).toBe(false);

    // The next account (B) starts on an empty memo store / feed.
    getMemoStore().setUserId('usr_bob');
    getNotificationFeed().setUserId('usr_bob');
    expect(getMemoStore().list()).toEqual([]);
    expect(getNotificationFeed().getSnapshot().items).toEqual([]);
  });
});
