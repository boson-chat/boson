import { describe, expect, it, vi } from 'vitest';
import { create } from '@bufbuild/protobuf';
import { ControlMessageSchema, Error_Code, Role, type ControlMessage, type RoomState } from '../quicvoice/gen/control_pb';
import { VoiceDiscoverer, cleanBaseURL, parseWellKnown, voiceDomain, voiceTrusted } from './discovery';
import { changeRoom, fetchRooms, roomInputWire } from './rooms';
import { WebVoiceService, classifyVoiceError, voiceQuality, voiceSendBitrate, type Conn, type Engine } from './service';

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers });

describe('discovery', () => {
  it('derives domains', () => {
    expect(voiceDomain('irc.boson.chat')).toBe('boson.chat');
    expect(voiceDomain('boson.chat')).toBe('boson.chat');
    expect(voiceDomain('localhost')).toBe('');
    expect(voiceDomain('127.0.0.1')).toBe('');
  });

  it('cleans base URLs', () => {
    expect(cleanBaseURL('https://Auth.Example/', false)).toBe('https://auth.example');
    expect(cleanBaseURL('http://a.example', false)).toBeNull();
    expect(cleanBaseURL('http://a.example', true)).toBe('http://a.example');
    expect(cleanBaseURL('https://a.example/?x=1', false)).toBeNull();
  });

  it('validates boson.json', () => {
    const doc = { version: 1, auth: { url: 'https://auth.example.org' }, voice: { addr: 'voice.example.org:7700', url: 'https://voice.example.org' } };
    expect(parseWellKnown(doc, false)).toEqual({ addr: 'voice.example.org:7700', url: 'https://voice.example.org', authUrl: 'https://auth.example.org', source: 'well-known' });
    expect(parseWellKnown({ version: 1 }, false)).toBeNull();
    expect(() => parseWellKnown({ version: 2 }, false)).toThrow();
    expect(() => parseWellKnown({ version: 1, voice: { addr: 'x:1', url: 'https://x' } }, false)).toThrow();
  });

  it('trusts voice only under its auth service domain', () => {
    const v = { addr: 'voice.boson.chat:7700', url: 'https://voice.boson.chat', authUrl: 'https://auth.boson.chat', source: 'well-known' as const };
    expect(voiceTrusted(v, 'https://auth.boson.chat', false)).toBe(true);
    expect(voiceTrusted(v, 'https://auth.other.chat', false)).toBe(false);
    expect(voiceTrusted({ ...v, addr: 'evil.com:7700' }, 'https://auth.boson.chat', false)).toBe(false);
    const local = { addr: '127.0.0.1:17700', url: 'http://127.0.0.1:18890', authUrl: 'http://127.0.0.1:18180', source: 'override' as const };
    expect(voiceTrusted(local, 'http://127.0.0.1:18180', true)).toBe(true);
    expect(voiceTrusted(local, 'http://127.0.0.1:18180', false)).toBe(false);
  });

  it('fetches boson.json, falls back to the voice API, caches, and uses overrides', async () => {
    const calls: string[] = [];
    const fetch = vi.fn(async (u: string) => {
      calls.push(u);
      if (u === 'https://boson.chat/.well-known/boson.json') {
        return json(200, { version: 1, auth: { url: 'https://auth.boson.chat' }, voice: { addr: 'voice.boson.chat:7700', url: 'https://voice.boson.chat' } });
      }
      if (u === 'https://other.net/.well-known/boson.json') return json(404, 'no');
      if (u === 'https://voice.other.net/v1/info') return json(200, { quic_port: 7701 });
      throw new Error('offline');
    }) as unknown as typeof globalThis.fetch;
    const d = new VoiceDiscoverer({ dev: false, fetch, storage: null, overrides: [JSON.stringify({ version: 1, irc: { host: 'localhost' }, auth: { url: 'http://127.0.0.1:1' }, voice: { addr: '127.0.0.1:2', url: 'http://127.0.0.1:3' } })] });
    expect((await d.discover('irc.boson.chat', false)).voice?.addr).toBe('voice.boson.chat:7700');
    await d.discover('irc.boson.chat', false);
    expect(calls.filter((c) => c.includes('boson.chat'))).toHaveLength(1);
    const o = await d.discover('irc.other.net', false);
    expect(o.voice).toMatchObject({ addr: 'voice.other.net:7701', source: 'probe', authUrl: 'https://auth.other.net' });
    expect((await d.discover('localhost', false)).voice?.source).toBe('override');
    const off = await d.discover('irc.offline.example', false);
    expect(off.voice).toBeNull();
    expect(off.definitive).toBe(false);
  });
});

describe('rooms API', () => {
  it('maps the room list and its errors', async () => {
    const ok = vi.fn(async () => json(200, {
      permissions: { can_create: true, create_scope: 'any', founded_channels: null },
      rooms: [{ id: 'general', name: 'General', participants: [{ session_id: 3, user_id: 'guest:x', name: 'n' }] }, { name: 'no id' }],
    })) as unknown as typeof fetch;
    const r = await fetchRooms(ok, 'https://v', 't');
    expect(r.rooms).toHaveLength(1);
    expect(r.rooms![0]).toMatchObject({ id: 'general', kind: 'static', minRole: 'member', canJoin: true, canSpeak: true });
    expect(r.rooms![0]!.participants[0]!.guest).toBe(true);
    expect(r.permissions).toEqual({ policy: undefined, canCreate: true, createScope: 'any', foundedChannels: [] });
    expect((await fetchRooms(vi.fn(async () => json(401, '')) as unknown as typeof fetch, 'https://v', 't')).errorKind).toBe('token');
    expect((await fetchRooms(vi.fn(async () => { throw new Error('x'); }) as unknown as typeof fetch, 'https://v', 't')).errorKind).toBe('unreachable');
  });

  it('changes rooms', async () => {
    expect(roomInputWire({ name: ' A ', parent: '#x', position: 2, minRole: 'op' }, true)).toEqual({ name: 'A', parent: '#x', min_role: 'op' });
    expect(roomInputWire({ position: 2 }, false)).toEqual({ position: 2 });
    const made = await changeRoom(vi.fn(async () => json(201, { id: 'r1', name: 'R' })) as unknown as typeof fetch, 'POST', 'u', 't', {});
    expect(made.room?.id).toBe('r1');
    expect(await changeRoom(vi.fn(async () => new Response(null, { status: 204 })) as unknown as typeof fetch, 'DELETE', 'u', 't')).toEqual({});
    const lim = await changeRoom(vi.fn(async () => json(429, { error: 'slow down', code: 'limit' }, { 'Retry-After': '30' })) as unknown as typeof fetch, 'POST', 'u', 't', {});
    expect(lim).toEqual({ error: 'slow down', code: 'limit', retryAfter: 30 });
    expect((await changeRoom(vi.fn(async () => json(403, '')) as unknown as typeof fetch, 'PATCH', 'u', 't', {})).code).toBe('forbidden');
  });
});

describe('helpers', () => {
  it('bitrates, quality, errors', () => {
    expect(voiceSendBitrate('standard', 0)).toEqual({ bps: 32000, music: false });
    expect(voiceSendBitrate('music', 64000)).toEqual({ bps: 64000, music: true });
    expect(voiceQuality(0, 0)).toBe('unknown');
    expect(voiceQuality(50, 1)).toBe('good');
    expect(voiceQuality(200, 5)).toBe('ok');
    expect(voiceQuality(400, 0)).toBe('poor');
    expect(classifyVoiceError({ code: Error_Code.ROOM_FULL, message: 'x' }, false).msg).toMatch(/full/);
    expect(classifyVoiceError(new Error('boom'), true).kind).toBe('unreachable');
  });
});

// A fake engine and connection, to drive the state machine.
function fakeEngine(): Engine & { calls: string[] } {
  const calls: string[] = [];
  let running = false;
  return {
    calls,
    get running() { return running; },
    start: async () => { running = true; calls.push('start'); },
    stop: () => { running = false; calls.push('stop'); },
    devices: async () => ({ inputs: [{ id: 'm', name: 'Mic', isDefault: false }], outputs: [] }),
    setDevices: async () => {},
    handleAudio: () => {},
    removeSender: (sid) => calls.push(`remove ${sid}`),
    setSender: (s) => calls.push(s ? 'sender' : 'nosender'),
    setPushToTalk: () => {},
    setPTT: () => {},
    setMuted: (m) => calls.push(`muted ${m}`),
    setDeafened: () => {},
    setLoopback: (on) => calls.push(`loopback ${on}`),
    setUserVolume: (sid, g) => calls.push(`vol ${sid} ${g}`),
    setVADThreshold: () => {},
    setQuality: (b, m) => calls.push(`quality ${b} ${m}`),
    setPlayoutDelay: () => {},
    playout: () => ({ ts: 48000, localUS: 5_000_000 }),
    stats: () => ({ micLevel: 0.5, transmitting: true, speaking: new Map([[2, true]]), lossPercent: 0 }),
  };
}

function fakeConn(state: Partial<RoomState>): Conn & { emit: (ev: string, x: unknown) => void; sent: unknown[] } {
  const ls = new Map<string, Array<(x: unknown) => void>>();
  const sent: unknown[] = [];
  return {
    sent,
    room: null,
    rttMs: 40,
    join: async () => state as RoomState,
    setMute: async (m, d) => { sent.push(['mute', m, d]); },
    on: ((ev: string, fn: (x: unknown) => void) => {
      ls.set(ev, [...(ls.get(ev) ?? []), fn]);
      return () => ls.set(ev, (ls.get(ev) ?? []).filter((f) => f !== fn));
    }) as Conn['on'],
    send: async (m) => { sent.push(m); },
    waitFor: () => new Promise(() => {}),
    close: () => { sent.push('close'); },
    emit: (ev, x) => { for (const f of ls.get(ev) ?? []) f(x); },
  };
}

const participant = (sid: number, user: string, extra: object = {}) => ({ sessionId: sid, userId: user, displayName: user, role: Role.SPEAKER, selfMuted: false, serverMuted: false, deafened: false, ...extra });
const ctrl = (msg: ControlMessage['msg']) => create(ControlMessageSchema, { msg } as never) as ControlMessage;

function service(conn: ReturnType<typeof fakeConn>, engine = fakeEngine(), audioError = '') {
  const discoverer = new VoiceDiscoverer({ dev: false, storage: null, fetch: vi.fn(async () => json(200, { version: 1, auth: { url: 'https://auth.boson.chat' }, voice: { addr: 'voice.boson.chat:7700', url: 'https://voice.boson.chat' } })) as unknown as typeof fetch });
  const dial = vi.fn(async () => conn);
  const s = new WebVoiceService({ authBase: 'https://auth.boson.chat', dev: false, discoverer, engine: () => engine, dial, audioError });
  return { s, dial, engine };
}

describe('WebVoiceService', () => {
  it('discovers, joins, follows the room, and leaves', async () => {
    const conn = fakeConn({ room: 'general', yourSessionId: 1, maxBitrate: 24000, participants: [participant(1, 'me'), participant(2, 'bob')] as never });
    const { s, dial, engine } = service(conn);
    const info = await s.discover('irc.boson.chat', false);
    expect(info).toMatchObject({ available: true, audio: true, authUrl: 'https://auth.boson.chat' });
    await s.setUserVolume('bob', 150);
    const st = await s.join({ host: 'irc.boson.chat', room: 'general', roomName: 'General', token: 'tok' });
    expect(dial).toHaveBeenCalledWith('https://voice.boson.chat:7700/wt', 'tok', { certHash: undefined });
    expect(st.status).toBe('connected');
    expect(st.participants.map((p) => [p.name, p.self, p.speaking, p.volume])).toEqual([['me', true, true, 100], ['bob', false, true, 150]]);
    expect(st.bitrate).toBe(24000);
    expect(engine.calls).toContain('quality 24000 false');
    expect(engine.calls).toContain('vol 2 1.5');

    s.onControl((s as unknown as { sess: never }).sess, ctrl({ case: 'participantJoined', value: { participant: participant(3, 'cy', { role: Role.LISTENER }) } } as never));
    expect((await s.state()).participants.find((p) => p.name === 'cy')?.listener).toBe(true);
    s.onControl((s as unknown as { sess: never }).sess, ctrl({ case: 'participantLeft', value: { sessionId: 2, reason: '' } } as never));
    expect((await s.state()).participants.map((p) => p.name)).toEqual(['me', 'cy']);
    expect(engine.calls).toContain('remove 2');

    // Lip sync: cy's audio clock + what plays → an offset.
    s.onControl((s as unknown as { sess: never }).sess, ctrl({ case: 'audioClock', value: { sessionId: 3, timestamp: 0, captureUs: 1_000_000n, version: 1 } } as never));
    expect(s.avOffsets().get('cy')).toBe(5_000_000 - 2_000_000);

    await s.setMuted(true);
    expect(conn.sent).toContainEqual(['mute', true, false]);
    await s.leave();
    expect((await s.state()).status).toBe('idle');
    expect(conn.sent).toContain('close');
    s.dispose();
  });

  it('is put out of a deleted room and reports a dropped connection', async () => {
    const conn = fakeConn({ room: 'r', yourSessionId: 1, participants: [participant(1, 'me')] as never });
    const { s } = service(conn);
    await s.discover('irc.boson.chat', false);
    await s.join({ host: 'irc.boson.chat', room: 'r', roomName: 'R', token: 't' });
    s.onControl((s as unknown as { sess: never }).sess, ctrl({ case: 'error', value: { code: Error_Code.KICKED, message: 'the channel was deleted', fatal: false } } as never));
    await Promise.resolve();
    const st = await s.state();
    expect(st).toMatchObject({ status: 'error', errorKind: 'kicked', error: 'The channel was deleted.' });
    await s.dismissError();
    expect((await s.state()).status).toBe('idle');

    const conn2 = fakeConn({ room: 'r', yourSessionId: 1, participants: [] as never });
    const { s: s2 } = service(conn2);
    await s2.discover('irc.boson.chat', false);
    await s2.join({ host: 'irc.boson.chat', room: 'r', roomName: 'R', token: 't' });
    conn2.emit('closed', 'gone');
    expect(await s2.state()).toMatchObject({ status: 'error', errorKind: 'dropped' });
    s.dispose();
    s2.dispose();
  });

  it('says why when the browser has no calls, and refuses untrusted voice', async () => {
    const { s } = service(fakeConn({}), fakeEngine(), 'Calls need a browser with WebTransport');
    const info = await s.discover('irc.boson.chat', false);
    expect(info).toMatchObject({ available: true, audio: false, audioError: 'Calls need a browser with WebTransport' });
    const st = await s.join({ host: 'irc.boson.chat', room: 'r', roomName: 'R', token: 't' });
    expect(st).toMatchObject({ status: 'error', errorKind: 'unavailable' });
    expect((await s.rooms('irc.nowhere.example', 't')).errorKind).toBe('unavailable');
    expect((await s.devices()).error).toMatch(/WebTransport/);
    s.dispose();
  });

  it("says another network's voice server may not take this web app, and keeps the plain message for its own", async () => {
    const doc = (domain: string) => ({ version: 1, auth: { url: `https://auth.${domain}` }, voice: { addr: `voice.${domain}:7700`, url: `https://voice.${domain}` } });
    const fetchFn = vi.fn(async (url: string) => {
      if (url === 'https://boson.chat/.well-known/boson.json') return json(200, doc('boson.chat'));
      if (url === 'https://boson.ircforever.org/.well-known/boson.json') return json(200, doc('boson.ircforever.org'));
      throw new TypeError('Failed to fetch'); // CORS refused / offline
    });
    const discoverer = new VoiceDiscoverer({ dev: false, storage: null, fetch: fetchFn as unknown as typeof fetch });
    // A self-hosted network's web client: its own auth is boson.ircforever.org's.
    const s = new WebVoiceService({
      authBase: 'https://auth.boson.ircforever.org', dev: false, discoverer, engine: () => fakeEngine(), dial: vi.fn(), audioError: '', fetch: fetchFn as unknown as typeof fetch,
    });
    await s.discover('irc.boson.chat', false);
    await s.discover('irc.boson.ircforever.org', false);
    const theirs = await s.rooms('irc.boson.chat', 't');
    expect(theirs.errorKind).toBe('unreachable');
    expect(theirs.error).toMatch(/^Couldn't reach voice\.boson\.chat\. That network's voice server may not take calls from this web app/);
    const ours = await s.rooms('irc.boson.ircforever.org', 't');
    expect(ours).toMatchObject({ errorKind: 'unreachable', error: "Couldn't reach the voice server." });
    expect(fetchFn).toHaveBeenCalledWith('https://voice.boson.ircforever.org/v1/rooms', expect.anything());
    s.dispose();
  });

  it('runs the mic test through the engine', async () => {
    const engine = fakeEngine();
    const { s } = service(fakeConn({}), engine);
    const st = await s.micTest(true);
    expect(st.micTest).toBe(true);
    expect(engine.calls).toContain('loopback true');
    await s.micTest(false);
    expect(engine.calls).toContain('stop');
    s.dispose();
  });
});
