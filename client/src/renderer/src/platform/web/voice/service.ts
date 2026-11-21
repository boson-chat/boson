// window.bosonVoice in the web build: the desktop VoiceService
// (desktop/voice.go) in TypeScript. Discovery and room lists over fetch;
// one call at a time over WebTransport (quicvoice 1.15+, https://host:port/wt)
// with the same control stream and audio datagrams as the desktop's QUIC;
// audio in WebAudioEngine. State is pushed 10 times a second while a call
// or the mic test runs, and on changes otherwise.
import type { VoiceBridge } from '../../../modules/voice/voice.bridge';
import type {
  VoiceDevices, VoiceErrorKind, VoiceJoinRequest, VoiceParticipant, VoiceQuality, VoiceRoomChange,
  VoiceRoomInput, VoiceRoomsResult, VoiceServerInfo, VoiceState,
} from '../../../modules/voice/voice.types';
import { AvClock } from './avsync';
import { cleanBaseURL, isLoopbackHost, splitHostPort, VoiceDiscoverer, voiceTrusted, type VoiceInfo } from './discovery';
import { changeRoom, fetchRooms, roomInputWire } from './rooms';
import type { ControlMessage, Participant, RoomState } from '../quicvoice/gen/control_pb';
import { Error_Code, Role } from '../quicvoice/gen/control_pb';

// What the service needs of the audio engine and the connection; the
// real ones are WebAudioEngine and QuicVoiceClient (tests fake them).
export interface Engine {
  readonly running: boolean;
  start(inputId: string, outputId: string): Promise<void>;
  stop(): void;
  devices(): Promise<{ inputs: Array<{ id: string; name: string; isDefault: boolean }>; outputs: Array<{ id: string; name: string; isDefault: boolean }> }>;
  setDevices(inputId: string, outputId: string): Promise<void>;
  handleAudio(d: unknown): void;
  removeSender(sid: number): void;
  setSender(s: unknown): void;
  setPushToTalk(on: boolean): void;
  setPTT(down: boolean): void;
  setMuted(m: boolean): void;
  setDeafened(d: boolean): void;
  setLoopback(on: boolean): void;
  setUserVolume(sid: number, gain: number): void;
  setVADThreshold(unit: number): void;
  setQuality(bitrate: number, music: boolean): void;
  setPlayoutDelay(sid: number, ms: number): void;
  playout(sid: number): { ts: number; localUS: number } | null;
  stats(): { micLevel: number; transmitting: boolean; speaking: Map<number, boolean>; lossPercent: number };
}

export interface Conn {
  room: RoomState | null;
  rttMs: number;
  join(room: string): Promise<RoomState>;
  setMute(muted: boolean, deafened: boolean): Promise<void>;
  on(ev: 'control', fn: (m: ControlMessage) => void): () => void;
  on(ev: 'audio', fn: (d: unknown) => void): () => void;
  on(ev: 'closed', fn: (reason: string) => void): () => void;
  send(msg: ControlMessage['msg']): Promise<void>;
  waitFor(pred: (m: ControlMessage) => boolean, ms?: number): Promise<ControlMessage>;
  close(reason?: string): void;
}

export type Dial = (url: string, token: string, opts: { certHash?: string }) => Promise<Conn>;

// What the call's video (web VideoService) hears from voice.
export interface VideoHooks {
  voiceJoined(conn: Conn): void;
  voiceLeft(): void;
}

export const VOICE_BITRATE = 32000;

export function voiceSendBitrate(quality: string, roomCap: number): { bps: number; music: boolean } {
  let bps = VOICE_BITRATE;
  let music = false;
  if (quality === 'high') bps = 64000;
  else if (quality === 'music') { bps = 128000; music = true; }
  if (roomCap > 0) bps = Math.min(bps, roomCap);
  return { bps, music };
}

export function voiceQuality(rttMs: number, loss: number): VoiceQuality {
  if (rttMs === 0) return 'unknown';
  if (rttMs < 120 && loss < 2) return 'good';
  if (rttMs < 300 && loss < 8) return 'ok';
  return 'poor';
}

export function classifyVoiceError(e: unknown, dialing: boolean): { kind: VoiceErrorKind; msg: string } {
  const code = (e as { code?: number }).code;
  const text = e instanceof Error ? e.message : String(e);
  if (code === Error_Code.UNAUTHENTICATED || code === Error_Code.TOKEN_EXPIRED) return { kind: 'token', msg: "The voice server didn't accept your sign-in. Try again." };
  if (code === Error_Code.FORBIDDEN || code === Error_Code.BANNED) return { kind: 'server', msg: "You're not allowed in this voice channel." };
  if (code === Error_Code.ROOM_FULL) return { kind: 'server', msg: 'This voice channel is full.' };
  if (code === Error_Code.ROOM_NOT_FOUND) return { kind: 'server', msg: "This voice channel doesn't exist any more." };
  if (code !== undefined) return { kind: 'server', msg: `The voice server refused: ${text}` };
  if (dialing || /timed out/i.test(text)) return { kind: 'unreachable', msg: "Couldn't reach the voice server. Check your connection and try again." };
  return { kind: 'server', msg: `Voice failed: ${text}` };
}

interface Member {
  userId: string;
  name: string;
  muted: boolean;
  deafened: boolean;
  listener: boolean;
}

function memberFrom(p: Participant): Member {
  return {
    userId: p.userId,
    name: p.displayName,
    muted: p.selfMuted || p.serverMuted,
    deafened: p.deafened,
    listener: p.role === Role.LISTENER,
  };
}

interface Session {
  conn: Conn;
  self: number;
  members: Map<number, Member>;
  clocks: Map<number, AvClock>;
  lastOffsets: Map<string, number>;
  left: boolean;
  offs: Array<() => void>;
}

export interface WebVoiceOptions {
  authBase: string;
  dev: boolean;
  discoverer: VoiceDiscoverer;
  engine: () => Engine;
  dial: Dial;
  // Why this browser can't do voice audio ('' when it can).
  audioError: string;
  fetch?: typeof fetch;
}

const dbToUnit = (db: number): number => Math.max(0, Math.min(1, 1 + db / 60));

export class WebVoiceService implements VoiceBridge {
  private engineInst: Engine | null = null;
  private sess: Session | null = null;
  private seq = 0;
  private status: VoiceState['status'] = 'idle';
  private host = '';
  private room = '';
  private roomName = '';
  private errMsg = '';
  private errKind: VoiceErrorKind | '' = '';
  private muted = false;
  private deafened = false;
  private pttMode = false;
  private vadDB = -45;
  private inputId = '';
  private outputId = '';
  private micTestOn = false;
  private micTestErr = '';
  private volumes = new Map<string, number>();
  private quality: 'standard' | 'high' | 'music' = 'standard';
  private roomCap = 0;
  private listeners = new Set<(s: VoiceState) => void>();
  private dirty = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  video: VideoHooks | null = null;
  private readonly fetchFn: typeof fetch;

  constructor(private opts: WebVoiceOptions) {
    this.fetchFn = opts.fetch ?? ((...a) => fetch(...a));
    this.timer = setInterval(() => this.tick(), 100);
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  // ---- discovery and rooms ----

  private trusted(info: VoiceInfo | null): boolean {
    if (!info) return false;
    return voiceTrusted(info, this.opts.authBase, this.opts.dev) || voiceTrusted(info, info.authUrl, this.opts.dev);
  }

  private trustedVoice(host: string): VoiceInfo | null {
    const d = this.opts.discoverer.cached(host);
    return d && this.trusted(d.voice) ? d.voice : null;
  }

  async discover(host: string, refresh: boolean): Promise<VoiceServerInfo> {
    const d = await this.opts.discoverer.discover(host, refresh);
    const out: VoiceServerInfo = { host: d.host, available: false, audio: false };
    if (d.voice) {
      out.authUrl = d.voice.authUrl;
      out.available = this.trusted(d.voice);
    }
    if (out.available) {
      out.audio = !this.opts.audioError;
      if (!out.audio) out.audioError = this.opts.audioError;
    }
    return out;
  }

  async rooms(host: string, token: string): Promise<VoiceRoomsResult> {
    const info = this.trustedVoice(host);
    if (!info) return { rooms: null, error: 'This server has no voice channels.', errorKind: 'unavailable' };
    if (!token) return { rooms: null, error: 'Sign in to use voice.', errorKind: 'token' };
    return fetchRooms(this.fetchFn, info.url, token);
  }

  private roomAPI(host: string, token: string): { info?: VoiceInfo; bad?: VoiceRoomChange } {
    const info = this.trustedVoice(host);
    if (!info) return { bad: { error: 'This server has no voice channels.', code: 'unavailable_voice' } };
    if (!token) return { bad: { error: 'Sign in to use voice.', code: 'unauthorized' } };
    return { info };
  }

  async createRoom(host: string, token: string, input: VoiceRoomInput): Promise<VoiceRoomChange> {
    const { info, bad } = this.roomAPI(host, token);
    if (bad) return bad;
    if (!input.name?.trim()) return { error: 'Give the voice channel a name.', code: 'invalid' };
    return changeRoom(this.fetchFn, 'POST', `${info!.url}/v1/rooms`, token, roomInputWire(input, true));
  }

  async updateRoom(host: string, token: string, id: string, input: VoiceRoomInput): Promise<VoiceRoomChange> {
    const { info, bad } = this.roomAPI(host, token);
    if (bad) return bad;
    if (!id) return { error: 'No voice channel given.', code: 'invalid' };
    return changeRoom(this.fetchFn, 'PATCH', `${info!.url}/v1/rooms/${encodeURIComponent(id)}`, token, roomInputWire(input, false));
  }

  async deleteRoom(host: string, token: string, id: string): Promise<VoiceRoomChange> {
    const { info, bad } = this.roomAPI(host, token);
    if (bad) return bad;
    if (!id) return { error: 'No voice channel given.', code: 'invalid' };
    return changeRoom(this.fetchFn, 'DELETE', `${info!.url}/v1/rooms/${encodeURIComponent(id)}`, token);
  }

  // ---- audio ----

  private engine(): Engine | null {
    if (this.opts.audioError) return null;
    if (!this.engineInst) {
      const e = this.opts.engine();
      e.setVADThreshold(dbToUnit(this.vadDB));
      e.setPushToTalk(this.pttMode);
      e.setMuted(this.muted || this.deafened);
      e.setDeafened(this.deafened);
      this.engineInst = e;
      this.applyQuality();
    }
    return this.engineInst;
  }

  private async startAudio(): Promise<{ kind: VoiceErrorKind; msg: string } | null> {
    const e = this.engine();
    if (!e) return { kind: 'unavailable', msg: this.opts.audioError };
    if (e.running) return null;
    try {
      await e.start(this.inputId, this.outputId);
      return null;
    } catch (err) {
      const name = (err as { name?: string }).name ?? '';
      if (name === 'NotAllowedError' || name === 'SecurityError') {
        return { kind: 'mic', msg: "Boson can't use your microphone. Allow it for this site in your browser (the icon next to the address), then try again." };
      }
      if (name === 'NotFoundError' || name === 'OverconstrainedError') return { kind: 'device', msg: 'No microphone was found. Plug one in and try again.' };
      return { kind: 'device', msg: `Couldn't open your audio device: ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  private stopAudioIfIdle(): void {
    if (this.sess || this.micTestOn || this.status === 'connecting') return;
    if (this.engineInst?.running) this.engineInst.stop();
  }

  async devices(): Promise<VoiceDevices> {
    const e = this.engine();
    if (!e) return { inputs: [], outputs: [], error: this.opts.audioError };
    try {
      const d = await e.devices();
      return { inputs: d.inputs, outputs: d.outputs };
    } catch (err) {
      return { inputs: [], outputs: [], error: err instanceof Error ? err.message : String(err) };
    }
  }

  async setDevices(inputId: string, outputId: string): Promise<string> {
    const changed = this.inputId !== inputId || this.outputId !== outputId;
    this.inputId = inputId;
    this.outputId = outputId;
    const e = this.engineInst;
    if (!changed || !e?.running) return '';
    try {
      await e.setDevices(inputId, outputId);
      return '';
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.errMsg = `Couldn't switch audio devices: ${msg}`;
      this.errKind = 'device';
      this.dirty = true;
      return msg;
    }
  }

  async micTest(on: boolean): Promise<VoiceState> {
    if (on) {
      const bad = await this.startAudio();
      if (bad) {
        this.micTestErr = bad.msg;
        this.dirty = true;
        return this.state();
      }
    }
    this.micTestOn = on;
    this.micTestErr = '';
    this.dirty = true;
    const e = this.engineInst;
    if (e) {
      e.setLoopback(on);
      if (!on) e.removeSender(0);
    }
    if (!on) this.stopAudioIfIdle();
    return this.state();
  }

  // ---- joining ----

  private async wtTarget(info: VoiceInfo): Promise<{ url: string; certHash?: string }> {
    const hp = splitHostPort(info.addr)!;
    const host = hp.host.includes(':') ? `[${hp.host}]` : hp.host;
    const url = `https://${host}:${hp.port}/wt`;
    // A local quicvoiced (dev, e2e) has a self-signed certificate: the
    // browser accepts it by hash (/v1/info dev_cert_hash).
    if (this.opts.dev && isLoopbackHost(hp.host)) {
      try {
        const r = await this.fetchFn(`${info.url}/v1/info`);
        const j = (await r.json()) as { dev_cert_hash?: string };
        if (j.dev_cert_hash) return { url, certHash: j.dev_cert_hash };
      } catch { /* no hash: try as is */ }
    }
    return { url };
  }

  async join(req: VoiceJoinRequest): Promise<VoiceState> {
    const info = this.trustedVoice(req.host);
    if (!info) { this.fail(0, 'unavailable', 'This server has no voice channels.'); return this.state(); }
    if (!req.room) { this.fail(0, 'server', 'No voice channel given.'); return this.state(); }
    if (!req.token) { this.fail(0, 'token', 'Sign in to use voice.'); return this.state(); }
    await this.leave();
    const seq = ++this.seq;
    this.status = 'connecting';
    this.host = req.host.toLowerCase();
    this.room = req.room;
    this.roomName = req.roomName || req.room;
    this.errMsg = '';
    this.errKind = '';
    this.dirty = true;

    const bad = await this.startAudio();
    if (bad) { this.fail(seq, bad.kind, bad.msg); return this.state(); }
    const e = this.engine()!;
    let conn: Conn;
    try {
      const t = await this.wtTarget(info);
      conn = await withTimeout(this.opts.dial(t.url, req.token, { certHash: t.certHash }), 8000);
    } catch (err) {
      const c = classifyVoiceError(err, true);
      this.fail(seq, c.kind, c.msg);
      return this.state();
    }
    const sess: Session = { conn, self: 0, members: new Map(), clocks: new Map(), lastOffsets: new Map(), left: false, offs: [] };
    // Control messages before the join answer (participants) count too.
    sess.offs.push(conn.on('control', (m) => this.onControl(sess, m)));
    sess.offs.push(conn.on('audio', (d) => { if (this.sess === sess) e.handleAudio(d); }));
    let state: RoomState;
    try {
      state = await conn.join(req.room);
    } catch (err) {
      for (const off of sess.offs) off();
      conn.close();
      const c = classifyVoiceError(err, false);
      this.fail(seq, c.kind, c.msg);
      return this.state();
    }
    if (this.seq !== seq) {
      for (const off of sess.offs) off();
      conn.close();
      return this.state();
    }
    sess.self = state.yourSessionId;
    for (const p of state.participants) sess.members.set(p.sessionId, memberFrom(p));
    this.sess = sess;
    this.status = 'connected';
    if (state.room) this.room = state.room;
    this.roomCap = state.maxBitrate;
    this.applyQuality();
    this.applyVolumes(sess);
    this.dirty = true;
    e.setSender({
      sendAudio: (u: unknown) => (conn as unknown as { sendAudio(x: unknown): void }).sendAudio(u),
      audioClock: (ts: number, us: number) => (conn as unknown as { audioClock(a: number, b: number): Promise<void> }).audioClock(ts, us),
    });
    if (this.muted || this.deafened) void conn.setMute(this.muted || this.deafened, this.deafened).catch(() => {});
    sess.offs.push(conn.on('closed', () => this.dropped(sess)));
    this.video?.voiceJoined(conn);
    return this.state();
  }

  async leave(): Promise<void> {
    this.seq++;
    const sess = this.sess;
    this.sess = null;
    if (sess) sess.left = true;
    if (this.status !== 'error' || sess) {
      this.status = 'idle';
      this.errMsg = '';
      this.errKind = '';
    }
    this.host = '';
    this.room = '';
    this.roomName = '';
    if (this.roomCap !== 0) {
      this.roomCap = 0;
      this.applyQuality();
    }
    this.dirty = true;
    if (sess) this.closeSession(sess);
    this.video?.voiceLeft();
    this.stopAudioIfIdle();
  }

  private closeSession(sess: Session): void {
    for (const off of sess.offs) off();
    const e = this.engineInst;
    if (e) {
      e.setSender(null);
      for (const sid of sess.members.keys()) e.removeSender(sid);
    }
    sess.conn.close();
  }

  private dropped(sess: Session): void {
    if (this.sess !== sess || sess.left) return;
    this.sess = null;
    this.status = 'error';
    this.errMsg = 'Lost the connection to the voice server.';
    this.errKind = 'dropped';
    this.dirty = true;
    this.closeSession(sess);
    this.video?.voiceLeft();
    this.stopAudioIfIdle();
  }

  private kicked(sess: Session, msg: string): void {
    if (this.sess !== sess) return;
    this.seq++;
    this.sess = null;
    sess.left = true;
    this.status = 'error';
    this.errMsg = msg;
    this.errKind = 'kicked';
    this.dirty = true;
    this.closeSession(sess);
    this.video?.voiceLeft();
    this.stopAudioIfIdle();
  }

  async dismissError(): Promise<void> {
    if (this.status === 'error') {
      this.status = 'idle';
      this.host = '';
      this.room = '';
      this.roomName = '';
    }
    this.errMsg = '';
    this.errKind = '';
    this.dirty = true;
  }

  private fail(seq: number, kind: VoiceErrorKind, msg: string): void {
    if (seq !== 0 && this.seq !== seq) return;
    this.status = 'error';
    this.errMsg = msg;
    this.errKind = kind;
    this.dirty = true;
    this.stopAudioIfIdle();
  }

  /** The control messages that change the state (desktop onControl). */
  onControl(sess: Session, m: ControlMessage): void {
    const e = this.engineInst;
    const current = this.sess === sess;
    switch (m.msg.case) {
      case 'participantJoined': {
        const p = m.msg.value.participant;
        if (!p) return;
        sess.members.set(p.sessionId, memberFrom(p));
        const v = this.volumes.get(p.userId);
        if (v !== undefined && current) e?.setUserVolume(p.sessionId, v / 100);
        break;
      }
      case 'audioClock': {
        const c = m.msg.value;
        if (!sess.members.has(c.sessionId)) return;
        let clk = sess.clocks.get(c.sessionId);
        if (!clk) { clk = new AvClock(); sess.clocks.set(c.sessionId, clk); }
        clk.report(c.timestamp, Number(c.captureUs));
        return;
      }
      case 'participantLeft': {
        const sid = m.msg.value.sessionId;
        sess.members.delete(sid);
        sess.clocks.delete(sid);
        if (current) e?.removeSender(sid);
        break;
      }
      case 'participantUpdated': {
        const p = m.msg.value.participant;
        if (p) sess.members.set(p.sessionId, memberFrom(p));
        break;
      }
      case 'roomSettings':
        if (current) {
          this.roomCap = m.msg.value.maxBitrate;
          this.applyQuality();
        }
        break;
      case 'error': {
        const err = m.msg.value;
        if (err.code === Error_Code.KICKED && !err.fatal && current) {
          const t = err.message;
          const msg = t ? `${t[0]!.toUpperCase()}${t.slice(1)}.` : 'You were removed from the voice channel.';
          queueMicrotask(() => this.kicked(sess, msg));
        }
        break;
      }
      default:
        return;
    }
    this.dirty = true;
  }

  /** Lip sync for video: per user id, local µs offset to add to a frame's capture time. */
  avOffsets(): Map<string, number> {
    const out = new Map<string, number>();
    const sess = this.sess;
    const e = this.engineInst;
    if (!sess || !e) return out;
    for (const [sid, clk] of sess.clocks) {
      const mem = sess.members.get(sid);
      if (!mem) continue;
      const p = e.playout(sid);
      if (!p) continue;
      const sender = clk.wallUS(p.ts);
      if (sender !== null) sess.lastOffsets.set(mem.userId, p.localUS - sender);
    }
    const here = new Set([...sess.members.values()].map((x) => x.userId));
    for (const [user, off] of sess.lastOffsets) {
      if (here.has(user)) out.set(user, off);
      else sess.lastOffsets.delete(user);
    }
    return out;
  }

  /** Delays one person's audio (lip sync, when their video lags). */
  setAudioDelay(userId: string, ms: number): void {
    const sess = this.sess;
    if (!sess || !this.engineInst) return;
    for (const [sid, mem] of sess.members) if (mem.userId === userId) this.engineInst.setPlayoutDelay(sid, ms);
  }

  // ---- controls ----

  async setMuted(muted: boolean): Promise<VoiceState> { return this.setMute(muted, undefined); }
  async setDeafened(deafened: boolean): Promise<VoiceState> { return this.setMute(undefined, deafened); }

  private setMute(muted?: boolean, deafened?: boolean): VoiceState {
    if (muted !== undefined) {
      this.muted = muted;
      if (!muted && this.deafened) this.deafened = false;
    }
    if (deafened !== undefined) this.deafened = deafened;
    this.dirty = true;
    this.engineInst?.setMuted(this.muted || this.deafened);
    this.engineInst?.setDeafened(this.deafened);
    void this.sess?.conn.setMute(this.muted || this.deafened, this.deafened).catch(() => {});
    return this.snapshot();
  }

  async setInputMode(mode: 'vad' | 'ptt'): Promise<void> {
    this.pttMode = mode === 'ptt';
    this.dirty = true;
    this.engineInst?.setPushToTalk(this.pttMode);
    this.engineInst?.setPTT(false);
  }

  async ptt(down: boolean): Promise<void> {
    this.engineInst?.setPTT(down);
  }

  async setVADThreshold(db: number): Promise<void> {
    this.vadDB = Math.max(-60, Math.min(0, db));
    this.engineInst?.setVADThreshold(dbToUnit(this.vadDB));
  }

  async setVoiceQuality(q: string): Promise<VoiceState> {
    const quality = q === 'high' || q === 'music' ? q : 'standard';
    if (quality !== this.quality) {
      this.quality = quality;
      this.applyQuality();
      this.dirty = true;
    }
    return this.state();
  }

  async setSpeaker(_on: boolean): Promise<VoiceState> {
    return this.state();
  }

  private applyQuality(): void {
    const { bps, music } = voiceSendBitrate(this.quality, this.roomCap);
    this.engineInst?.setQuality(bps, music);
  }

  async setUserVolume(userId: string, percent: number): Promise<void> {
    if (!userId) return;
    this.volumes.set(userId, Math.max(0, Math.min(200, Math.round(percent))));
    if (this.sess) this.applyVolumes(this.sess);
    this.dirty = true;
  }

  private applyVolumes(sess: Session): void {
    const e = this.engineInst;
    if (!e) return;
    for (const [sid, m] of sess.members) {
      const v = this.volumes.get(m.userId);
      if (v !== undefined) e.setUserVolume(sid, v / 100);
    }
  }

  // ---- state ----

  async state(): Promise<VoiceState> {
    return this.snapshot();
  }

  snapshot(): VoiceState {
    const e = this.engineInst;
    const es = e?.running ? e.stats() : null;
    const { bps } = voiceSendBitrate(this.quality, this.roomCap);
    const st: VoiceState = {
      status: this.status, host: this.host, room: this.room, roomName: this.roomName,
      error: this.errMsg || undefined, errorKind: (this.errKind || undefined) as VoiceErrorKind | undefined,
      participants: [], muted: this.muted, deafened: this.deafened, pushToTalk: this.pttMode,
      micTest: this.micTestOn, micTestError: this.micTestErr || undefined,
      micLevel: es?.micLevel ?? 0, transmitting: es?.transmitting ?? false,
      rttMs: 0, lossPercent: 0, quality: 'unknown', speaker: true,
      audioError: this.opts.audioError || undefined,
      voiceQuality: this.quality, bitrate: bps, maxBitrate: this.roomCap || undefined,
    };
    const sess = this.sess;
    if (!sess) return st;
    st.rttMs = sess.conn.rttMs;
    st.lossPercent = es?.lossPercent ?? 0;
    st.quality = voiceQuality(st.rttMs, st.lossPercent);
    const parts: VoiceParticipant[] = [];
    for (const [sid, m] of sess.members) {
      const p: VoiceParticipant = {
        sessionId: sid, userId: m.userId, name: m.name, self: sid === sess.self,
        muted: m.muted, deafened: m.deafened, speaking: false, volume: this.volumes.get(m.userId) ?? 100,
        listener: m.listener, guest: m.userId.startsWith('guest:') || undefined,
      };
      if (p.self) {
        p.muted = this.muted || this.deafened || m.listener;
        p.deafened = this.deafened;
        p.speaking = !!es?.transmitting && !m.listener;
        st.listener = m.listener;
      } else {
        p.speaking = !!es?.speaking.get(sid);
      }
      parts.push(p);
    }
    parts.sort((a, b) => a.sessionId - b.sessionId);
    st.participants = parts;
    return st;
  }

  onState(fn: (s: VoiceState) => void): () => void {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  }

  private tick(): void {
    const live = !!this.sess || this.micTestOn || this.status === 'connecting';
    if (!live && !this.dirty) return;
    this.dirty = false;
    const s = this.snapshot();
    for (const fn of this.listeners) fn(s);
  }
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timed out connecting to the voice server')), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

export { cleanBaseURL };
