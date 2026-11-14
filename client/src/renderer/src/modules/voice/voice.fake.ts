// An in-memory VoiceBridge, for unit tests and the screenshot harness
// (shots.tsx). Not used by the app.

import type { VoiceBridge } from './voice.bridge';
import {
  IDLE_VOICE_STATE, type VoiceDevices, type VoiceJoinRequest, type VoiceRoom, type VoiceRoomChange,
  type VoiceRoomInput, type VoiceRoomPermissions, type VoiceRoomsResult, type VoiceServerInfo, type VoiceState,
} from './voice.types';

export interface FakeVoiceOptions {
  // host → discovery answer; hosts not here have no voice.
  servers?: Record<string, Partial<VoiceServerInfo>>;
  // host → rooms (or an error result).
  rooms?: Record<string, VoiceRoom[] | VoiceRoomsResult>;
  // host → what you may create there (default: nothing).
  permissions?: Record<string, VoiceRoomPermissions>;
  devices?: VoiceDevices;
  // What joining does: the state to end in (default: connected, just you).
  onJoin?: (req: VoiceJoinRequest, prev: VoiceState) => VoiceState;
  // Answer room changes with this instead (an error, say).
  onChange?: (method: 'create' | 'update' | 'delete', host: string, input: VoiceRoomInput | null, id: string | null) => VoiceRoomChange | null;
}

export interface FakeVoiceBridge extends VoiceBridge {
  calls: Array<{ method: string; args: unknown[] }>;
  current: VoiceState;
  push(patch: Partial<VoiceState>): void;
  opts: FakeVoiceOptions;
}

export function createFakeVoiceBridge(opts: FakeVoiceOptions = {}): FakeVoiceBridge {
  const listeners = new Set<(s: VoiceState) => void>();
  const log = (method: string, ...args: unknown[]): void => { fake.calls.push({ method, args }); };
  const set = (patch: Partial<VoiceState>): VoiceState => {
    fake.current = { ...fake.current, ...patch };
    listeners.forEach((fn) => fn(fake.current));
    return fake.current;
  };
  const roomList = (host: string): VoiceRoom[] => {
    const r = opts.rooms?.[host];
    if (Array.isArray(r)) return r;
    if (r && r.rooms) return r.rooms;
    opts.rooms = { ...opts.rooms, [host]: [] };
    return opts.rooms[host] as VoiceRoom[];
  };
  const fake: FakeVoiceBridge = {
    calls: [],
    current: { ...IDLE_VOICE_STATE },
    opts,
    push: (patch) => { set(patch); },
    async discover(host, refresh) {
      log('discover', host, refresh);
      const s = opts.servers?.[host];
      return { host, available: !!s, audio: true, authUrl: 'https://auth.boson.chat', ...s };
    },
    async rooms(host, token) {
      log('rooms', host, token);
      const r = opts.rooms?.[host];
      const permissions = opts.permissions?.[host];
      if (!r) return { rooms: [], permissions };
      return Array.isArray(r) ? { rooms: r.map((x) => ({ ...x })), permissions } : { permissions, ...r };
    },
    async createRoom(host, token, input) {
      log('createRoom', host, token, input);
      const forced = opts.onChange?.('create', host, input, null);
      if (forced) return forced;
      const rooms = roomList(host);
      const parent = (input.parent ?? '').toLowerCase();
      const id = slug(`${parent.replace(/^#/, '')} ${input.name ?? ''}`) || 'room';
      const room: VoiceRoom = {
        id, name: (input.name ?? '').trim(), kind: 'dynamic', parent, owner: { userId: 'usr_me', name: 'me' },
        position: rooms.length, minRole: input.minRole ?? 'member', speakRole: input.speakRole ?? 'member',
        requireChannelMembership: !!input.requireChannelMembership, canManage: true, canJoin: true, canSpeak: true, participants: [],
      };
      rooms.push(room);
      return { room };
    },
    async updateRoom(host, token, id, input) {
      log('updateRoom', host, token, id, input);
      const forced = opts.onChange?.('update', host, input, id);
      if (forced) return forced;
      const rooms = roomList(host);
      const i = rooms.findIndex((r) => r.id === id);
      if (i < 0) return { error: 'no such room', code: 'not_found' };
      const { parent: _ignored, ...patch } = input;
      rooms[i] = { ...rooms[i]!, ...patch };
      rooms.sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
      return { room: rooms.find((r) => r.id === id) };
    },
    async deleteRoom(host, token, id) {
      log('deleteRoom', host, token, id);
      const forced = opts.onChange?.('delete', host, null, id);
      if (forced) return forced;
      const rooms = roomList(host);
      const i = rooms.findIndex((r) => r.id === id);
      if (i < 0) return { error: 'no such room', code: 'not_found' };
      rooms.splice(i, 1);
      return {};
    },
    async join(req) {
      log('join', req);
      const next = opts.onJoin?.(req, fake.current) ?? {
        ...fake.current, status: 'connected', host: req.host, room: req.room, roomName: req.roomName,
        error: undefined, errorKind: undefined, rttMs: 38, quality: 'good',
        participants: [{ sessionId: 1, userId: 'usr_me', name: 'me', self: true, muted: fake.current.muted, deafened: fake.current.deafened, speaking: false, volume: 100 }],
      };
      return set(next);
    },
    async leave() { log('leave'); set({ ...IDLE_VOICE_STATE, muted: fake.current.muted, deafened: fake.current.deafened, pushToTalk: fake.current.pushToTalk }); },
    async dismissError() { log('dismissError'); set({ status: 'idle', host: '', room: '', roomName: '', error: undefined, errorKind: undefined }); },
    async setMuted(muted) { log('setMuted', muted); return set({ muted, deafened: muted ? fake.current.deafened : false }); },
    async setDeafened(deafened) { log('setDeafened', deafened); return set({ deafened }); },
    async setInputMode(mode) { log('setInputMode', mode); set({ pushToTalk: mode === 'ptt' }); },
    async ptt(down) { log('ptt', down); },
    async setVADThreshold(db) { log('setVADThreshold', db); },
    async setUserVolume(userId, percent) { log('setUserVolume', userId, percent); },
    async devices() {
      log('devices');
      return opts.devices ?? {
        inputs: [{ id: 'mic1', name: 'MacBook Pro Microphone', isDefault: true }, { id: 'mic2', name: 'Shure MV7', isDefault: false }],
        outputs: [{ id: 'out1', name: 'MacBook Pro Speakers', isDefault: true }, { id: 'out2', name: 'AirPods Pro', isDefault: false }],
      };
    },
    async setDevices(inputId, outputId) { log('setDevices', inputId, outputId); return ''; },
    async micTest(on) { log('micTest', on); return set({ micTest: on, micTestError: undefined, micLevel: on ? 0.62 : 0, transmitting: on }); },
    async state() { return fake.current; },
    onState(fn) {
      listeners.add(fn);
      return () => { listeners.delete(fn); };
    },
  };
  return fake;
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}
