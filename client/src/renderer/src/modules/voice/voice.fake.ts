// An in-memory VoiceBridge, for unit tests and the screenshot harness
// (shots.tsx). Not used by the app.

import type { VoiceBridge } from './voice.bridge';
import {
  IDLE_VOICE_STATE, type VoiceDevices, type VoiceJoinRequest, type VoiceRoom, type VoiceRoomsResult,
  type VoiceServerInfo, type VoiceState,
} from './voice.types';

export interface FakeVoiceOptions {
  // host → discovery answer; hosts not here have no voice.
  servers?: Record<string, Partial<VoiceServerInfo>>;
  // host → rooms (or an error result).
  rooms?: Record<string, VoiceRoom[] | VoiceRoomsResult>;
  devices?: VoiceDevices;
  // What joining does: the state to end in (default: connected, just you).
  onJoin?: (req: VoiceJoinRequest, prev: VoiceState) => VoiceState;
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
      if (!r) return { rooms: [] };
      return Array.isArray(r) ? { rooms: r } : r;
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
