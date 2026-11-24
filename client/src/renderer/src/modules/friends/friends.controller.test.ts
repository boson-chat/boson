import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { VoiceController } from '../voice';
import { createFakeVoiceBridge, type FakeVoiceBridge } from '../voice/voice.fake';
import { FriendsController, friendlyError } from './friends.controller';
import { FakeFriendsApi, type FakeFriendsOptions } from './friends.fake';
import { HttpFriendsApi, callFromWire } from './friends.api';

const HOST = 'irc.boson.example';

async function settle(ms = 20): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

interface Rig {
  api: FakeFriendsApi;
  ctl: FriendsController;
  voice: VoiceController;
  bridge: FakeVoiceBridge;
  camera: boolean[];
  opened: number;
  signedIn: { on: boolean; fire: () => void };
}

async function rig(opts: Partial<FakeFriendsOptions> = {}): Promise<Rig> {
  const bridge = createFakeVoiceBridge({ servers: { [HOST]: {} } });
  const voice = new VoiceController(bridge, {
    authUrl: 'https://auth.boson.chat',
    voiceToken: async () => ({ token: 'channel-token', expiresAt: Date.now() + 300_000 }),
    pollMs: 3_600_000,
    keyTarget: null,
  });
  await voice.discover(HOST);
  const api = new FakeFriendsApi({
    people: [
      { username: 'kestrel', rel: 'friend' },
      { username: 'mox', rel: 'friend', anytime: true },
      { username: 'pixel' },
      { username: 'nova', rel: 'incoming', calls: 'everyone' },
      { username: 'orbit', rel: 'blocked' },
      { username: 'ghost', rel: 'friend', blockedMe: true },
    ],
    pollWaitMs: 5,
    ...opts,
  });
  const camera: boolean[] = [];
  const listeners = new Set<() => void>();
  const signedIn = { on: true, fire: () => listeners.forEach((fn) => fn()) };
  const r: Rig = { api, voice, bridge, camera, opened: 0, signedIn, ctl: null as unknown as FriendsController };
  r.ctl = new FriendsController({
    api, authUrl: 'https://auth.boson.chat', signedIn: () => signedIn.on, me: () => 'ada',
    onAccessChange: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
    voice: () => voice,
    video: () => ({ setCameraOnJoin: (on: boolean) => camera.push(on) }) as never,
    openCall: () => { r.opened++; },
    backoffMs: [5], toastMs: 50, outcomeMs: 30,
  });
  r.ctl.start();
  await settle();
  return r;
}

describe('FriendsController', () => {
  let r: Rig;
  beforeEach(async () => { r = await rig(); });
  afterEach(() => r.ctl.dispose());

  it('loads the lists and settings when signed in, and clears them on sign-out', async () => {
    const s = r.ctl.getSnapshot();
    expect(s.available).toBe(true);
    expect(s.loaded).toBe(true);
    expect(s.friends.map((f) => f.username)).toEqual(['kestrel', 'mox', 'ghost']);
    expect(s.incoming.map((f) => f.username)).toEqual(['nova']);
    expect(s.blocked.map((f) => f.username)).toEqual(['orbit']);
    expect(s.privacy.calls).toBe('friends');
    expect(s.signedIn).toBe(true);
    expect(s.unsupported).toBe(false);
    r.signedIn.on = false;
    r.signedIn.fire();
    expect(r.ctl.getSnapshot().available).toBe(false);
    expect(r.ctl.getSnapshot().signedIn).toBe(false);
    expect(r.ctl.getSnapshot().friends).toEqual([]);
  });

  it('sign-out hangs up the call (ending it server-side) and drops everything', async () => {
    const c = r.api.ring('kestrel', false);
    await settle();
    await r.ctl.accept(c.id, false);
    await settle();
    const end = vi.spyOn(r.api, 'endCall');
    await r.ctl.clearForSignOut();
    expect(r.bridge.calls.some((x) => x.method === 'leave')).toBe(true);
    expect(end).toHaveBeenCalledWith(c.id);
    const s = r.ctl.getSnapshot();
    expect(s.active).toBeNull();
    expect(s.friends).toEqual([]);
    expect(s.available).toBe(false);
  });

  it('only offers person menus on servers whose voice takes this account', async () => {
    expect(r.ctl.peopleHere(HOST)).toBe(true);
    expect(r.ctl.peopleHere('irc.elsewhere.example')).toBe(false);
    expect(r.ctl.peopleHere(null)).toBe(false);
    expect(r.ctl.isMe('ADA')).toBe(true);
  });

  it('rings, and accepting joins the call room with the call token, camera as chosen', async () => {
    const c = r.api.ring('kestrel', true);
    await settle();
    expect(r.ctl.getSnapshot().ringing.map((x) => x.id)).toEqual([c.id]);
    await r.ctl.accept(c.id, false);
    await settle();
    const join = r.bridge.calls.find((x) => x.method === 'join');
    expect(join?.args[0]).toMatchObject({ host: HOST, room: c.room, roomName: 'Call with kestrel', token: 't' });
    expect(r.camera).toEqual([false]);
    expect(r.opened).toBe(1);
    expect(r.ctl.getSnapshot().ringing).toEqual([]);
    expect(r.ctl.getSnapshot().active?.call.id).toBe(c.id);
    expect(r.ctl.getSnapshot().active?.since).toBeGreaterThan(0);
    // Hanging up (leaving the room) ends the call for both.
    await r.voice.leave();
    await settle();
    expect(r.api.log).toContain(`ended ${c.id}`);
    expect(r.ctl.getSnapshot().active).toBeNull();
    expect(r.ctl.getSnapshot().toast?.text).toMatch(/^Call ended · 00:0\d$/);
  });

  it('declines', async () => {
    const c = r.api.ring('kestrel', false);
    await settle();
    await r.ctl.decline(c.id);
    expect(r.api.log).toContain(`declined ${c.id}`);
    expect(r.ctl.getSnapshot().ringing).toEqual([]);
    expect(r.bridge.calls.some((x) => x.method === 'join')).toBe(false);
  });

  it('a call answered elsewhere stops ringing here', async () => {
    const c = r.api.ring('kestrel', false);
    await settle();
    (r.api as unknown as { push: (e: unknown) => void }).push({ type: 'call.update', call: { ...c, state: 'answered' } });
    await settle();
    expect(r.ctl.getSnapshot().ringing).toEqual([]);
  });

  it('calls out; when answered, joins with a token from the calls API and a video camera', async () => {
    r.ctl.dispose();
    r = await rig({ answerAfter: 10 });
    await r.ctl.call('mox', true);
    expect(r.ctl.getSnapshot().calling).toMatchObject({ status: 'calling', video: true });
    await settle(60);
    expect(r.ctl.getSnapshot().calling).toBeNull();
    const join = r.bridge.calls.find((x) => x.method === 'join');
    expect(join?.args[0]).toMatchObject({ room: expect.stringMatching(/^call:/), roomName: 'Call with mox', token: 't' });
    expect(r.camera).toEqual([true]);
  });

  it('shows busy when declined, then closes', async () => {
    r.ctl.dispose();
    r = await rig({ answerAfter: 5, decline: true });
    await r.ctl.call('kestrel', false);
    await settle(20);
    expect(r.ctl.getSnapshot().calling?.status).toBe('declined');
    await settle(60);
    expect(r.ctl.getSnapshot().calling).toBeNull();
    expect(r.bridge.calls.some((x) => x.method === 'join')).toBe(false);
  });

  it('a blocked caller just sees unavailable', async () => {
    await r.ctl.call('ghost', false);
    expect(r.ctl.getSnapshot().calling?.status).toBe('unavailable');
  });

  it('a refused call says why and never shows the calling screen', async () => {
    await r.ctl.call('pixel', false);
    expect(r.ctl.getSnapshot().calling).toBeNull();
    expect(r.ctl.getSnapshot().toast?.text).toBe('pixel only takes calls from friends.');
  });

  it('cancels a ringing call', async () => {
    await r.ctl.call('kestrel', false);
    const id = r.ctl.getSnapshot().calling?.call?.id;
    await r.ctl.cancelCall();
    expect(r.ctl.getSnapshot().calling).toBeNull();
    expect(r.api.log).toContain(`missed ${id}`);
  });

  it('when they hang up, leaves the room', async () => {
    const c = r.api.ring('kestrel', false);
    await settle();
    await r.ctl.accept(c.id, false);
    await settle();
    (r.api as unknown as { push: (e: unknown) => void }).push({ type: 'call.update', call: { ...c, state: 'ended' } });
    await settle();
    expect(r.bridge.calls.some((x) => x.method === 'leave')).toBe(true);
    expect(r.ctl.getSnapshot().active).toBeNull();
  });

  it('friend requests, blocks and settings', async () => {
    expect(await r.ctl.sendRequest('@pixel')).toBe(true);
    expect(r.ctl.getSnapshot().toast?.text).toBe('Friend request sent to pixel');
    await settle();
    expect(r.ctl.getSnapshot().outgoing.map((f) => f.username)).toEqual(['pixel']);
    await r.ctl.acceptRequest({ userId: 'usr_nova', username: 'nova', displayName: '' });
    expect(r.ctl.getSnapshot().toast?.text).toBe('You and nova are now friends');
    await r.ctl.block('kestrel');
    await settle();
    expect(r.ctl.getSnapshot().blocked.map((f) => f.username)).toContain('kestrel');
    await r.ctl.setPrivacy({ calls: 'nobody', doNotDisturb: true });
    expect(r.ctl.getSnapshot().privacy).toMatchObject({ calls: 'nobody', doNotDisturb: true });
    expect(await r.ctl.sendRequest('nobody-here')).toBe(false);
    expect(r.ctl.getSnapshot().toast?.text).toBe('No one by that name.');
  });

  it('missed calls: counted from the feed, listed and cleared when seen', async () => {
    r.ctl.dispose();
    r = await rig({ missed: [{ from: 'kestrel', video: true, minutesAgo: 3 }] });
    expect(r.ctl.getSnapshot().missed).toBe(1);
    await r.ctl.seeMissed();
    expect(r.ctl.getSnapshot().missed).toBe(0);
    expect(r.ctl.getSnapshot().missedCalls.map((c) => c.peer.username)).toEqual(['kestrel']);
  });

  it('caches relations until something changes', async () => {
    const spy = vi.spyOn(r.api, 'relation');
    await r.ctl.relation('kestrel');
    await r.ctl.relation('Kestrel');
    expect(spy).toHaveBeenCalledTimes(1);
    await r.ctl.sendRequest('pixel');
    await r.ctl.relation('kestrel');
    expect(spy).toHaveBeenCalledTimes(2);
  });
});

describe('HttpFriendsApi', () => {
  it('maps the wire format and paths', async () => {
    const calls: Array<[string, string, unknown]> = [];
    const answers: Record<string, unknown> = {
      'GET /v1/friends': { friends: [{ user_id: 'usr_1', username: 'mira', display_name: 'Mira', can_call_anytime: true, since: 's' }], incoming: [], outgoing: null, blocked: [] },
      'GET /v1/events?cursor=ab.3': { cursor: 'ab.4', reset: false, events: [
        { seq: 4, type: 'call.ring', data: { id: 'cal_1', room: 'call:cal_1', video: true, state: 'ringing', direction: 'incoming', peer: { user_id: 'usr_1', username: 'mira' }, created_at: '2026-11-20T10:00:00Z', expires_at: '2026-11-20T10:00:45Z' } },
        { seq: 5, type: 'missed', data: { count: 2 } },
        { seq: 6, type: 'something.new', data: {} },
      ] },
      'POST /v1/calls/cal_1/accept': { call: { id: 'cal_1', state: 'answered' }, voice: { token: 'vt', room: 'call:cal_1', expires_in: 300 } },
      'PATCH /v1/me/privacy': { calls: 'everyone', do_not_disturb: true, friend_requests: 'servers' },
    };
    const api = new HttpFriendsApi({
      request: async <T,>(method: string, path: string, body?: unknown) => { calls.push([method, path, body]); return answers[`${method} ${path}`] as T; },
    });
    const l = await api.lists();
    expect(l.friends[0]).toEqual({ userId: 'usr_1', username: 'mira', displayName: 'Mira', canCallAnytime: true, since: 's' });
    expect(l.outgoing).toEqual([]);
    const p = await api.poll('ab.3');
    expect(p.events.map((e) => e.type)).toEqual(['call.ring', 'missed']);
    expect(p.events[0]).toMatchObject({ call: { id: 'cal_1', video: true, peer: { username: 'mira' }, expiresAt: Date.parse('2026-11-20T10:00:45Z') } });
    const a = await api.acceptCall('cal_1');
    expect(a.voice.token).toBe('vt');
    expect(await api.setPrivacy({ calls: 'everyone', doNotDisturb: true })).toEqual({ calls: 'everyone', doNotDisturb: true, friendRequests: 'servers' });
    expect(calls.find((c) => c[0] === 'PATCH')?.[2]).toEqual({ calls: 'everyone', do_not_disturb: true });
    await api.relation('we/ird');
    expect(calls.at(-1)?.[1]).toBe('/v1/users/we%2Fird/relation');
    expect(callFromWire({}).state).toBe('ended');
  });
});

describe('friendlyError', () => {
  it('keeps the server reason for refusals and maps the rest', () => {
    expect(friendlyError({ code: 'calls_off', message: "mira isn't taking calls" }, 'x')).toBe("mira isn't taking calls.");
    expect(friendlyError({ code: 'you_blocked', message: 'you blocked mira; unblock them first' }, 'x')).toBe('You blocked mira; unblock them first.');
    expect(friendlyError({ code: 'rate_limited' }, 'x')).toBe('Slow down a little and try again.');
    expect(friendlyError(new Error('boom'), 'Fallback')).toBe('Fallback');
  });
});

describe('FriendsController on an older auth service', () => {
  it('stays off while the event feed is missing (404)', async () => {
    const api = new FakeFriendsApi({ people: [] });
    let n = 0;
    api.poll = async () => { n++; throw Object.assign(new Error('404 page not found'), { code: 'http_404', status: 404 }); };
    const ctl = new FriendsController({
      api, authUrl: 'https://auth.boson.chat', signedIn: () => true, me: () => 'ada', onAccessChange: () => () => {},
      voice: () => null, video: () => null, openCall: () => {}, unsupportedRetryMs: 10_000,
    });
    ctl.start();
    await settle(30);
    expect(ctl.getSnapshot().available).toBe(false);
    // Signed in, but its server has no friends: not "sign in".
    expect(ctl.getSnapshot().signedIn).toBe(true);
    expect(ctl.getSnapshot().unsupported).toBe(true);
    expect(n).toBe(1);
    ctl.dispose();
  });
});
