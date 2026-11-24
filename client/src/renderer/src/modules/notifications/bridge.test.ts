import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FriendsController, setFriendsController } from '../friends';
import { FakeFriendsApi } from '../friends/friends.fake';
import { VoiceController, setVoiceController } from '../voice';
import { createFakeVoiceBridge } from '../voice/voice.fake';
import type { VoiceRoom } from '../voice/voice.types';
import { __resetNotificationSettingsCache, setNotificationSettings } from '../ui/notifications.store';
import { NotificationFeed, setNotificationFeed } from './feed';
import { startNotificationBridge } from './bridge';

const HOST = 'irc.nebula.example';
const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));
let api: FakeFriendsApi;
let ctl: FriendsController;
let voice: VoiceController;
let rooms: VoiceRoom[];
let feed: NotificationFeed;
let stop: () => void;

beforeEach(async () => {
  localStorage.clear();
  __resetNotificationSettingsCache();
  feed = new NotificationFeed();
  setNotificationFeed(feed);
  rooms = [
    { id: 'general', name: 'General', participants: [] },
    { id: 'ops-room', name: 'Ops', parent: '#ops', participants: [] },
    { id: 'dev-room', name: 'Dev', parent: '#dev', participants: [] },
  ];
  const vb = createFakeVoiceBridge({ servers: { [HOST]: {} }, rooms: { [HOST]: rooms } });
  voice = new VoiceController(vb, { authUrl: 'https://auth.boson.chat', voiceToken: async () => ({ token: 'x', expiresAt: Date.now() + 300_000 }), pollMs: 3_600_000, keyTarget: null });
  setVoiceController(voice);
  await voice.discover(HOST);
  await voice.refreshRooms(HOST, true);
  api = new FakeFriendsApi({ people: [{ username: 'kestrel', rel: 'friend' }, { username: 'pixel', rel: 'outgoing' }], pollWaitMs: 5 });
  ctl = new FriendsController({
    api, authUrl: 'https://auth.boson.chat', signedIn: () => true, me: () => 'ada', onAccessChange: () => () => {},
    voice: () => voice, video: () => null, openCall: () => {}, toastMs: 1_000,
  });
  setFriendsController(ctl);
  ctl.start();
  await tick();
  stop = startNotificationBridge({ scope: () => [{ host: HOST, serverId: 's1', serverName: 'Nebula', channels: ['#dev'] }] });
  await tick();
});

afterEach(() => {
  stop();
  setFriendsController(null);
  setVoiceController(null);
  setNotificationFeed(null);
});

describe('notification bridge', () => {
  it('a friend request: listed, and a toast with the person to accept', async () => {
    api.requestFrom('juno');
    await tick(60);
    const { items, toasts } = feed.getSnapshot();
    expect(items[0]).toMatchObject({ kind: 'friend', sub: 'request', title: 'juno' });
    expect(toasts[0]).toMatchObject({ kind: 'friend', title: 'juno' });
    expect(toasts[0]!.friend?.username).toBe('juno');
  });

  it('an accepted request: "pixel accepted your friend request"', async () => {
    api.acceptedBy('pixel');
    await tick(60);
    expect(feed.getSnapshot().toasts[0]).toMatchObject({ kind: 'accepted', title: 'pixel accepted your friend request' });
  });

  it('a call that rings out: a missed-call toast with who to call back', async () => {
    const c = api.ring('kestrel', true);
    await tick(40);
    expect(ctl.getSnapshot().ringing).toHaveLength(1);
    api.missRing(c.id);
    await tick(60);
    expect(feed.getSnapshot().toasts[0]).toMatchObject({ kind: 'missed', title: 'Missed call', call: { peer: 'kestrel', video: true } });
    expect(feed.getSnapshot().items.filter((i) => i.sub === 'missed')).toHaveLength(1);
  });

  it('one read state: seeing missed calls on the Calls page reads them in the bell', async () => {
    const c = api.ring('kestrel', true);
    await tick(40);
    api.missRing(c.id);
    await tick(60);
    expect(ctl.getSnapshot().missed).toBeGreaterThan(0);
    expect(feed.unread()).toBe(1);
    await ctl.seeMissed();
    await tick();
    expect(feed.unread()).toBe(0);
  });

  it('one read state: a request answered anywhere is read in the bell', async () => {
    api.requestFrom('juno');
    await tick(60);
    expect(feed.unread()).toBe(1);
    const juno = ctl.getSnapshot().incoming.find((f) => f.username === 'juno')!;
    await ctl.acceptRequest(juno);
    await tick(60);
    expect(feed.unread()).toBe(0);
  });

  it('declining is not a missed call', async () => {
    const c = api.ring('kestrel', false);
    await tick(40);
    await ctl.decline(c.id);
    await tick(40);
    expect(feed.getSnapshot().toasts).toHaveLength(0);
  });

  it('a call starting in a voice channel you are in (or a server-wide one), not elsewhere', async () => {
    const p = (name: string) => ({ sessionId: 1, userId: `u_${name}`, name, muted: false, deafened: false, speaking: false });
    rooms[2]!.participants.push(p('nova'));
    rooms[1]!.participants.push(p('mox'));
    await voice.refreshRooms(HOST, true);
    await tick();
    expect(feed.getSnapshot().toasts.map((t) => [t.kind, t.where])).toEqual([['started', 'Dev · Nebula']]);
    rooms[0]!.participants.push(p('kestrel'), p('juno'));
    await voice.refreshRooms(HOST, true);
    await tick();
    expect(feed.getSnapshot().toasts[0]).toMatchObject({ kind: 'started', body: 'kestrel, juno are in General', room: { roomId: 'general', serverName: 'Nebula' } });
  });

  it('respects the Friends and Calls switches (still listed)', async () => {
    setNotificationSettings({ friends: false, calls: false });
    api.requestFrom('juno');
    await tick(60);
    expect(feed.getSnapshot().toasts).toHaveLength(0);
    expect(feed.getSnapshot().items[0]).toMatchObject({ title: 'juno' });
  });
});
