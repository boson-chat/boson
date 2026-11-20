import { describe, it, expect, beforeEach, vi } from 'vitest';
import { VoiceController, VoiceRoomError, tokenErrorText } from './voice.controller';
import { createFakeVoiceBridge } from './voice.fake';
import { __resetVoiceSettings } from './voice.settings';
import { guestVoiceId, isGuestParticipant } from './guest-id';
import { AuthError } from '../auth/auth.service';

const MAIN = 'https://auth.boson.chat';
const ROOMS = [{ id: 'general', name: 'General', canManage: true, participants: [] }];

function setup(o: { account?: boolean; guestVoice?: boolean; nick?: string | null } = {}) {
  const bridge = createFakeVoiceBridge({
    servers: { 'irc.boson.chat': {} },
    rooms: { 'irc.boson.chat': ROOMS },
    permissions: { 'irc.boson.chat': { canCreate: true, createScope: 'any', foundedChannels: [] } },
  });
  const state = { account: o.account ?? false, guestVoice: o.guestVoice ?? true };
  const voiceToken = vi.fn(async (rooms?: string[]) => ({ token: `acct:${rooms?.join(',') ?? 'list'}`, expiresAt: Date.now() + 300_000 }));
  const guestVoice = vi.fn(async () => state.guestVoice);
  const guestVoiceToken = vi.fn(async (_auth: string, nick: string, rooms?: string[]) => ({ token: `guest:${nick}:${rooms?.join(',') ?? 'list'}`, expiresAt: Date.now() + 300_000 }));
  const c = new VoiceController(bridge, {
    authUrl: MAIN, voiceToken, pollMs: 60_000, keyTarget: null,
    hasAccount: () => state.account, guestVoice, guestVoiceToken,
  });
  if (o.nick !== null) c.setNick('irc.boson.chat', o.nick ?? 'kit');
  return { bridge, c, state, voiceToken, guestVoice, guestVoiceToken };
}

describe('VoiceController guest voice', () => {
  beforeEach(() => {
    localStorage.clear();
    __resetVoiceSettings();
  });

  it('keeps account voice unchanged for account users', async () => {
    const { c, bridge, guestVoice, guestVoiceToken, voiceToken } = setup({ account: true });
    await c.discover('irc.boson.chat');
    const s = c.getSnapshot().servers['irc.boson.chat']!;
    expect(s.discovery).toBe('available');
    expect(s.guest).toBe(false);
    await c.refreshRooms('irc.boson.chat', true);
    expect(c.getSnapshot().servers['irc.boson.chat']!.permissions.canCreate).toBe(true);
    await c.join('irc.boson.chat', { id: 'general', name: 'General' });
    expect(voiceToken).toHaveBeenLastCalledWith(['general']);
    expect(bridge.calls.find((x) => x.method === 'join')!.args[0]).toMatchObject({ token: 'acct:general' });
    expect(guestVoice).not.toHaveBeenCalled();
    expect(guestVoiceToken).not.toHaveBeenCalled();
  });

  it('joins as a guest under the IRC nick when the auth service allows guest voice', async () => {
    const { c, bridge, voiceToken, guestVoiceToken } = setup({ nick: 'Kit' });
    await c.discover('irc.boson.chat');
    expect(c.getSnapshot().servers['irc.boson.chat']!.guest).toBe(true);
    await c.refreshRooms('irc.boson.chat', true);
    const s = c.getSnapshot().servers['irc.boson.chat']!;
    // Never create or manage as a guest, whatever the server says.
    expect(s.permissions.canCreate).toBe(false);
    expect(s.rooms![0]!.canManage).toBe(false);
    expect(bridge.calls.find((x) => x.method === 'rooms')!.args).toEqual(['irc.boson.chat', 'guest:Kit:list']);
    await c.join('irc.boson.chat', { id: 'general', name: 'General' });
    expect(guestVoiceToken).toHaveBeenLastCalledWith(MAIN, 'Kit', ['general']);
    expect(bridge.calls.find((x) => x.method === 'join')!.args[0]).toMatchObject({ token: 'guest:Kit:general' });
    expect(voiceToken).not.toHaveBeenCalled();
    await expect(c.createRoom('irc.boson.chat', { name: 'x' })).rejects.toBeInstanceOf(VoiceRoomError);
    expect(bridge.calls.some((x) => x.method === 'createRoom')).toBe(false);
  });

  it('uses account voice (and its sign-in error) when guest voice is off', async () => {
    const { c, guestVoiceToken } = setup({ guestVoice: false });
    await c.discover('irc.boson.chat');
    expect(c.getSnapshot().servers['irc.boson.chat']!.guest).toBe(false);
    expect(guestVoiceToken).not.toHaveBeenCalled();
  });

  it('says to connect first when there is no nick yet', async () => {
    const { c } = setup({ nick: null });
    await c.discover('irc.boson.chat');
    await c.join('irc.boson.chat', { id: 'general', name: 'General' });
    expect(c.getSnapshot().call).toMatchObject({ status: 'error', errorKind: 'token', error: 'Connect to the server first to use voice as a guest.' });
  });

  it('shows a friendly error when the nick belongs to an account', async () => {
    const { c, guestVoiceToken } = setup();
    guestVoiceToken.mockRejectedValue(new AuthError('nick_registered', 'nick registered', 409));
    await c.discover('irc.boson.chat');
    await c.join('irc.boson.chat', { id: 'general', name: 'General' });
    expect(c.getSnapshot().call.error).toBe('That name belongs to an account — sign in to use voice.');
  });

  it('switches between guest and account voice when sign-in changes', async () => {
    const { c, state, voiceToken } = setup();
    await c.discover('irc.boson.chat');
    expect(c.getSnapshot().servers['irc.boson.chat']!.guest).toBe(true);
    state.account = true;
    await c.accessChanged();
    expect(c.getSnapshot().servers['irc.boson.chat']!.guest).toBe(false);
    await c.join('irc.boson.chat', { id: 'general', name: 'General' });
    expect(voiceToken).toHaveBeenLastCalledWith(['general']);
    state.account = false;
    await c.accessChanged();
    expect(c.getSnapshot().servers['irc.boson.chat']!.guest).toBe(true);
  });

  it('asks the auth service about guest voice once per few minutes', async () => {
    const { c, guestVoice } = setup();
    await c.discover('irc.boson.chat');
    await c.discover('irc.boson.chat', true);
    await c.accessChanged();
    expect(guestVoice).toHaveBeenCalledTimes(1);
  });
});

describe('tokenErrorText', () => {
  it('explains guest token errors', () => {
    expect(tokenErrorText(new AuthError('nick_registered', 'x', 409))).toBe('That name belongs to an account — sign in to use voice.');
    expect(tokenErrorText(new AuthError('invalid_request', 'x', 400))).toMatch(/nick can't be used/);
    expect(tokenErrorText(new AuthError('rate_limited', 'x', 429))).toMatch(/Too many/);
    expect(tokenErrorText(new AuthError('http_429', 'x', 429))).toMatch(/Too many/);
    expect(tokenErrorText(new AuthError('guest_voice_disabled', 'x', 403))).toMatch(/doesn't let guests/);
    expect(tokenErrorText(new AuthError('signed_out', 'x', 401))).toBe('Sign in to your Boson account to use voice.');
  });
});

describe('guest ids', () => {
  beforeEach(() => localStorage.clear());

  it('makes one random id per auth service and keeps it', () => {
    const a = guestVoiceId(MAIN);
    expect(a).toMatch(/^[A-Za-z0-9_-]{16,64}$/);
    expect(guestVoiceId(MAIN)).toBe(a);
    expect(guestVoiceId('https://auth.other.net')).not.toBe(a);
    localStorage.setItem(`boson.voice.guestId:${MAIN}`, 'bad id!');
    expect(guestVoiceId(MAIN)).toMatch(/^[A-Za-z0-9_-]{16,64}$/);
  });

  it('tells guest participants apart', () => {
    expect(isGuestParticipant({ guest: true, userId: 'x' })).toBe(true);
    expect(isGuestParticipant({ userId: 'guest:abc' })).toBe(true);
    expect(isGuestParticipant({ userId: 'usr_1' })).toBe(false);
    expect(isGuestParticipant(null)).toBe(false);
  });
});
