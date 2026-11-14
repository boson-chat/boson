import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { VoiceController, normalizeAuthUrl } from './voice.controller';
import { createFakeVoiceBridge } from './voice.fake';
import { __resetVoiceSettings, getVoiceSettings, setVoiceSettings } from './voice.settings';

const GENERAL = { id: 'general', name: 'General', participants: [
  { sessionId: 3, userId: 'usr_a', name: 'alice', muted: false, deafened: false, speaking: true },
] };

function setup(opts: Parameters<typeof createFakeVoiceBridge>[0] = {}) {
  const bridge = createFakeVoiceBridge({
    servers: { 'irc.boson.chat': {} },
    rooms: { 'irc.boson.chat': [GENERAL] },
    ...opts,
  });
  const keys = new EventTarget();
  const voiceToken = vi.fn(async (rooms?: string[]) => ({ token: rooms ? `tok-${rooms.join(',')}` : 'list-tok', expiresAt: Date.now() + 300_000 }));
  const c = new VoiceController(bridge, {
    authUrl: 'https://auth.boson.chat/', voiceToken, pollMs: 50,
    keyTarget: keys as unknown as Window,
  });
  return { bridge, c, voiceToken, keys };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('VoiceController', () => {
  beforeEach(() => {
    localStorage.clear();
    __resetVoiceSettings();
  });
  afterEach(() => { vi.useRealTimers(); });

  it('normalizes auth URLs', () => {
    expect(normalizeAuthUrl('https://Auth.Boson.chat/')).toBe('https://auth.boson.chat');
    expect(normalizeAuthUrl('')).toBe('');
  });

  it('offers voice only for servers on our auth service', async () => {
    const { c } = setup({
      servers: {
        'irc.boson.chat': {},
        'irc.other.net': { authUrl: 'https://auth.other.net' },
      },
    });
    await c.discover('IRC.boson.chat');
    await c.discover('irc.other.net');
    await c.discover('irc.ircforever.org');
    const s = c.getSnapshot().servers;
    expect(s['irc.boson.chat']?.discovery).toBe('available');
    expect(s['irc.other.net']?.discovery).toBe('none');
    expect(s['irc.ircforever.org']?.discovery).toBe('none');
  });

  it('discovers once, and again on refresh', async () => {
    const { c, bridge } = setup();
    await c.discover('irc.boson.chat');
    await c.discover('irc.boson.chat');
    expect(bridge.calls.filter((x) => x.method === 'discover')).toHaveLength(1);
    await c.discover('irc.boson.chat', true);
    expect(bridge.calls.filter((x) => x.method === 'discover').map((x) => x.args[1])).toEqual([false, true]);
  });

  it('polls rooms while watched, reusing a list token', async () => {
    const { c, bridge, voiceToken } = setup();
    await c.discover('irc.boson.chat');
    const stop = c.watchRooms('irc.boson.chat');
    await new Promise((r) => setTimeout(r, 130));
    stop();
    const n = bridge.calls.filter((x) => x.method === 'rooms').length;
    expect(n).toBeGreaterThanOrEqual(2);
    expect(voiceToken).toHaveBeenCalledTimes(1);
    expect(c.getSnapshot().servers['irc.boson.chat']?.rooms?.[0]?.name).toBe('General');
    await new Promise((r) => setTimeout(r, 120));
    expect(bridge.calls.filter((x) => x.method === 'rooms').length).toBe(n);
  });

  it('shows a room-list error', async () => {
    const { c } = setup({ rooms: { 'irc.boson.chat': { rooms: null, error: 'down', errorKind: 'unreachable' } } });
    await c.discover('irc.boson.chat');
    await c.refreshRooms('irc.boson.chat', true);
    const s = c.getSnapshot().servers['irc.boson.chat']!;
    expect(s.roomsError).toBe('down');
    expect(s.roomsErrorKind).toBe('unreachable');
  });

  it('reports a token failure on the room list', async () => {
    const { c, voiceToken } = setup();
    voiceToken.mockRejectedValueOnce(Object.assign(new Error('x'), { code: 'signed_out' }));
    await c.discover('irc.boson.chat');
    await c.refreshRooms('irc.boson.chat', true);
    expect(c.getSnapshot().servers['irc.boson.chat']?.roomsErrorKind).toBe('token');
  });

  it('joins with a token for that room', async () => {
    const { c, bridge, voiceToken } = setup();
    await c.join('irc.boson.chat', GENERAL, 'boson');
    expect(voiceToken).toHaveBeenCalledWith(['general']);
    expect(bridge.calls.find((x) => x.method === 'join')?.args[0]).toEqual({ host: 'irc.boson.chat', room: 'general', roomName: 'General', token: 'tok-general' });
    const snap = c.getSnapshot();
    expect(snap.call.status).toBe('connected');
    expect(snap.callServerName).toBe('boson');
  });

  it('a token failure on join is an inline error', async () => {
    const { c, bridge, voiceToken } = setup();
    voiceToken.mockRejectedValueOnce(Object.assign(new Error('offline'), { code: 'network' }));
    await c.join('irc.boson.chat', GENERAL);
    expect(c.getSnapshot().call.status).toBe('error');
    expect(c.getSnapshot().call.errorKind).toBe('token');
    expect(bridge.calls.some((x) => x.method === 'join')).toBe(false);
  });

  it('pushes settings to the bridge, and changes as they happen', async () => {
    setVoiceSettings({ inputId: 'mic2', mode: 'ptt', vadDb: -40, userVolumes: { usr_a: 150 } });
    const { c, bridge } = setup();
    expect(bridge.calls.map((x) => x.method)).toEqual(expect.arrayContaining(['setDevices', 'setInputMode', 'setVADThreshold', 'setUserVolume']));
    bridge.calls = [];
    c.setUserVolume('usr_b', 60);
    expect(bridge.calls).toEqual([{ method: 'setUserVolume', args: ['usr_b', 60] }]);
    expect(getVoiceSettings().userVolumes).toEqual({ usr_a: 150, usr_b: 60 });
    expect(c.userVolume('usr_b')).toBe(60);
    expect(c.userVolume('usr_x')).toBe(100);
  });

  it('push to talk: the key, only in a call, released on blur', async () => {
    setVoiceSettings({ mode: 'ptt', pttCode: 'Backquote' });
    const { c, bridge, keys } = setup();
    const key = (type: string, code: string, extra: Record<string, unknown> = {}) => {
      const e = new KeyboardEvent(type, { code, key: code === 'Backquote' ? '`' : 'x', cancelable: true, ...extra });
      keys.dispatchEvent(e);
      return e;
    };
    key('keydown', 'Backquote');
    expect(bridge.calls.some((x) => x.method === 'ptt')).toBe(false);
    await c.join('irc.boson.chat', GENERAL);
    bridge.calls = [];
    const down = key('keydown', 'Backquote');
    expect(down.defaultPrevented).toBe(true);
    key('keydown', 'Backquote', { repeat: true });
    key('keydown', 'KeyA');
    key('keyup', 'Backquote');
    expect(bridge.calls).toEqual([{ method: 'ptt', args: [true] }, { method: 'ptt', args: [false] }]);
    bridge.calls = [];
    key('keydown', 'Backquote');
    keys.dispatchEvent(new Event('blur'));
    expect(bridge.calls).toEqual([{ method: 'ptt', args: [true] }, { method: 'ptt', args: [false] }]);
  });

  it('mute, deafen, leave', async () => {
    const { c } = setup();
    await c.join('irc.boson.chat', GENERAL);
    await c.setDeafened(true);
    expect(c.getSnapshot().call.deafened).toBe(true);
    await c.setMuted(false);
    expect(c.getSnapshot().call.deafened).toBe(false);
    await c.leave();
    await flush();
    expect(c.getSnapshot().call.status).toBe('idle');
    expect(c.getSnapshot().callServerName).toBe('');
  });

  it('without a bridge, nothing', async () => {
    const c = new VoiceController(null, { authUrl: 'https://auth.boson.chat', voiceToken: vi.fn() });
    expect(c.supported).toBe(false);
    await c.discover('irc.boson.chat');
    expect(c.getSnapshot().servers).toEqual({});
  });
});
