// The web build's voice audio (the desktop's quicvoice engine, in the
// browser): the mic through getUserMedia (the browser's echo
// cancellation, noise suppression and gain control) into an AudioWorklet
// that cuts 20 ms 48 kHz frames; voice activity / push-to-talk gating;
// WebCodecs Opus encoding into uplink datagrams; per-sender WebCodecs
// decoders feeding the mixer worklet's jitter buffers; AudioClock reports
// for lip sync, and which sender timestamps play when.
import captureUrl from './capture.worklet.ts?worker&url';
import mixerUrl from './mixer.worklet.ts?worker&url';
import type { Downlink } from '../quicvoice/wire';
import { FLAG_END, FLAG_START, FRAME_SAMPLES, type JitterFrame } from './jitter';
import type { MixerMessage } from './mixer.worklet';

export interface AudioSender {
  sendAudio(u: { flags: number; voice: boolean; level: number; seq: number; timestamp: number; payload: Uint8Array }): void;
  audioClock(timestamp: number, captureUS: number): Promise<void> | void;
}

export interface EngineStats {
  micLevel: number;
  transmitting: boolean;
  speaking: Map<number, boolean>;
  lossPercent: number;
  // The audio context runs (a suspended one captures and plays nothing).
  audioRunning?: boolean;
  // ms since the mic's last 20 ms frame (since start when none yet).
  captureIdleMs?: number;
  // ms since the mic's last frame that wasn't digital silence.
  silentMs?: number;
  // The mic in use (its label), and whether the system muted its track.
  micName?: string;
  micMuted?: boolean;
}

export interface AudioDeviceInfo { id: string; name: string; isDefault: boolean }

export const LOOPBACK_SESSION = 0;
const VAD_HANGOVER = 15; // frames (300 ms)
const SPEAKING_WINDOW_MS = 300;
const CLOCK_REPORT_MS = 1000;

/** Frame loudness on 0..1 over -60..0 dBFS. */
export function rmsUnit(frame: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < frame.length; i++) sum += frame[i]! * frame[i]!;
  const rms = Math.sqrt(sum / frame.length);
  if (rms <= 0) return 0;
  return Math.min(Math.max(1 + (20 * Math.log10(rms)) / 60, 0), 1);
}

/** 0..1 back to the wire's -dBov (0 loud .. 127 silent). */
export function unitToLevel(u: number): number {
  return u <= 0 ? 127 : Math.round((1 - u) * 60);
}

const nowUS = (): number => Math.round((performance.timeOrigin + performance.now()) * 1000);

interface Receiver {
  dec: AudioDecoder;
  meta: Array<{ seq: number; ts: number; flags: number }>;
  lastVoice: number;
  // Loss over a window: received frames vs the sequence span seen.
  got: number;
  first: number | null;
  last: number;
}

export class WebAudioEngine {
  private ctx: AudioContext | null = null;
  private mic: MediaStream | null = null;
  private capture: AudioWorkletNode | null = null;
  private mixer: AudioWorkletNode | null = null;
  private enc: AudioEncoder | null = null;
  private encMeta: Array<{ seq: number; ts: number; flags: number; voice: boolean; level: number; captureUS: number }> = [];
  private sender: AudioSender | null = null;
  private receivers = new Map<number, Receiver>();
  private ptt = false;
  private pttDown = false;
  private muted = false;
  private deafened = false;
  private loopback = false;
  private vad = 0.25;
  private bitrate = 32000;
  private music = false;
  private encConfigured = '';
  // Capture state.
  private seq = 0;
  private ts = (Math.random() * 0xffffffff) >>> 0;
  private sending = false;
  private hang = 0;
  private lastReport = 0;
  private micLevel = 0;
  private transmitting = false;
  // Lip sync: what each sender's audio is playing, from the mixer.
  private playoutAt = new Map<number, { ts: number; localUS: number }>();
  private loss = 0;
  private outputId = '';

  /** WebTransport + WebCodecs Opus in this browser; what's missing otherwise. */
  static async support(): Promise<{ ok: boolean; missing: string[] }> {
    const missing: string[] = [];
    const g = globalThis as Record<string, unknown>;
    if (typeof g.WebTransport !== 'function') missing.push('WebTransport');
    if (typeof g.AudioWorkletNode !== 'function') missing.push('AudioWorklet');
    let opus = false;
    try {
      if (typeof g.AudioEncoder === 'function' && typeof g.AudioDecoder === 'function') {
        const cfg = { codec: 'opus', sampleRate: 48000, numberOfChannels: 1 };
        const [e, d] = await Promise.all([
          AudioEncoder.isConfigSupported({ ...cfg, bitrate: 32000 }),
          AudioDecoder.isConfigSupported(cfg),
        ]);
        opus = !!e.supported && !!d.supported;
      }
    } catch { opus = false; }
    if (!opus) missing.push('Opus audio (WebCodecs)');
    return { ok: missing.length === 0, missing };
  }

  get running(): boolean {
    return this.ctx !== null;
  }

  async start(inputId: string, outputId: string): Promise<void> {
    this.stop();
    const audio: MediaTrackConstraints = { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 };
    if (inputId) audio.deviceId = { exact: inputId };
    const mic = await navigator.mediaDevices.getUserMedia({ audio });
    const ctx = new AudioContext({ latencyHint: 'interactive' });
    try {
      await ctx.audioWorklet.addModule(captureUrl);
      await ctx.audioWorklet.addModule(mixerUrl);
      // The capture node reaches the destination through a silent gain:
      // WebKit (Safari) only runs nodes the destination pulls, so an
      // output-less worklet node there never saw the mic.
      const capture = new AudioWorkletNode(ctx, 'boson-capture', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
      const mixer = new AudioWorkletNode(ctx, 'boson-mixer', { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2] });
      const silent = ctx.createGain();
      silent.gain.value = 0;
      ctx.createMediaStreamSource(mic).connect(capture);
      capture.connect(silent);
      silent.connect(ctx.destination);
      mixer.connect(ctx.destination);
      capture.port.onmessage = (ev: MessageEvent<{ pcm: Float32Array; at: number }>) => this.onCaptured(ev.data.pcm);
      mixer.port.onmessage = (ev: MessageEvent<{ type: string; at: number; playing: Array<{ sid: number; ts: number }> }>) => {
        if (ev.data.type === 'playout') this.onPlayout(ev.data.at, ev.data.playing);
      };
      this.ctx = ctx;
      this.mic = mic;
      this.capture = capture;
      this.mixer = mixer;
      this.post({ type: 'deafen', on: this.deafened });
      this.startedAt = performance.now();
      this.lastCapture = 0;
      this.lastSound = 0;
      // A context made without a recent user gesture (a call answered from
      // the other side, Safari's stricter rule) starts suspended, and its
      // resume() waits for a gesture: don't hold the join on it; the next
      // click or key anywhere resumes it (watchGestures).
      if (ctx.state !== 'running') void ctx.resume().catch(() => {});
      this.watchGestures();
      await this.applyOutput(outputId);
    } catch (e) {
      for (const t of mic.getTracks()) t.stop();
      void ctx.close().catch(() => {});
      throw e;
    }
  }

  private startedAt = 0;
  private lastCapture = 0;
  private lastSound = 0;
  private offGestures: (() => void) | null = null;

  /** Resumes a suspended (or Safari "interrupted") context on any user gesture. */
  private watchGestures(): void {
    this.offGestures?.();
    if (typeof document === 'undefined') return;
    const resume = (): void => {
      const ctx = this.ctx;
      if (ctx && ctx.state !== 'running' && ctx.state !== 'closed') void ctx.resume().catch(() => {});
    };
    const evs = ['pointerdown', 'keydown', 'touchend'] as const;
    for (const ev of evs) document.addEventListener(ev, resume, { capture: true });
    document.addEventListener('visibilitychange', resume);
    this.offGestures = () => {
      for (const ev of evs) document.removeEventListener(ev, resume, { capture: true });
      document.removeEventListener('visibilitychange', resume);
    };
  }

  /** Tries to start a suspended context (from a user gesture). */
  resume(): void {
    const ctx = this.ctx;
    if (ctx && ctx.state !== 'running' && ctx.state !== 'closed') void ctx.resume().catch(() => {});
  }

  stop(): void {
    this.offGestures?.();
    this.offGestures = null;
    this.post({ type: 'stop' });
    this.capture?.port.postMessage({ type: 'stop' });
    for (const t of this.mic?.getTracks() ?? []) t.stop();
    void this.ctx?.close().catch(() => {});
    for (const r of this.receivers.values()) if (r.dec.state !== 'closed') r.dec.close();
    this.receivers.clear();
    if (this.enc && this.enc.state !== 'closed') this.enc.close();
    this.enc = null;
    this.encConfigured = '';
    this.encMeta = [];
    this.ctx = null;
    this.mic = null;
    this.capture = null;
    this.mixer = null;
    this.micLevel = 0;
    this.transmitting = false;
    this.sending = false;
    this.playoutAt.clear();
  }

  async devices(): Promise<{ inputs: AudioDeviceInfo[]; outputs: AudioDeviceInfo[] }> {
    const all = await navigator.mediaDevices.enumerateDevices();
    const map = (kind: MediaDeviceKind): AudioDeviceInfo[] => all
      .filter((d) => d.kind === kind && d.deviceId !== 'default' && d.deviceId !== 'communications' && d.deviceId !== '')
      .map((d, i) => ({ id: d.deviceId, name: d.label || (kind === 'audioinput' ? `Microphone ${i + 1}` : `Speakers ${i + 1}`), isDefault: false }));
    return { inputs: map('audioinput'), outputs: map('audiooutput') };
  }

  /** Switches devices on a running engine (the mic restarts; output via setSinkId). */
  async setDevices(inputId: string, outputId: string): Promise<void> {
    if (!this.ctx) return;
    const sender = this.sender;
    await this.start(inputId, outputId);
    this.sender = sender;
  }

  private async applyOutput(outputId: string): Promise<void> {
    this.outputId = outputId;
    const ctx = this.ctx as (AudioContext & { setSinkId?: (id: string) => Promise<void> }) | null;
    if (ctx?.setSinkId && outputId) await ctx.setSinkId(outputId).catch(() => {});
  }

  get output(): string { return this.outputId; }

  setSender(s: AudioSender | null): void { this.sender = s; }
  setPushToTalk(on: boolean): void { this.ptt = on; }
  setPTT(down: boolean): void { this.pttDown = down; }
  setMuted(m: boolean): void { this.muted = m; }
  setDeafened(d: boolean): void {
    this.deafened = d;
    this.post({ type: 'deafen', on: d });
  }
  setLoopback(on: boolean): void { this.loopback = on; }
  setVADThreshold(unit: number): void { this.vad = Math.min(Math.max(unit, 0), 1); }
  setUserVolume(sid: number, gain: number): void { this.post({ type: 'gain', sid, gain }); }
  setQuality(bitrate: number, music: boolean): void {
    this.bitrate = Math.min(Math.max(bitrate, 6000), 510000);
    this.music = music;
  }
  /** Lip sync: delays one sender's audio by ms (20 ms frames, ≤ 200 ms). */
  setPlayoutDelay(sid: number, ms: number): void {
    const frames = Math.ceil(Math.min(Math.max(ms, 0), 200) / 20);
    this.post({ type: 'delay', sid, frames });
  }

  removeSender(sid: number): void {
    const r = this.receivers.get(sid);
    if (r && r.dec.state !== 'closed') r.dec.close();
    this.receivers.delete(sid);
    this.playoutAt.delete(sid);
    this.post({ type: 'remove', sid });
  }

  /** Which of a sender's audio timestamps reaches the speaker when (Unix µs). */
  playout(sid: number): { ts: number; localUS: number } | null {
    return this.playoutAt.get(sid) ?? null;
  }

  stats(): EngineStats {
    const now = performance.now();
    const speaking = new Map<number, boolean>();
    for (const [sid, r] of this.receivers) speaking.set(sid, now - r.lastVoice < SPEAKING_WINDOW_MS);
    return {
      micLevel: this.micLevel, transmitting: this.transmitting, speaking, lossPercent: this.loss,
      audioRunning: this.ctx?.state === 'running',
      captureIdleMs: now - (this.lastCapture || this.startedAt),
      silentMs: now - (this.lastSound || this.startedAt),
      micName: this.mic?.getAudioTracks()[0]?.label,
      micMuted: !!this.mic?.getAudioTracks()[0]?.muted,
    };
  }

  // ---- receiving ----

  handleAudio(d: Downlink): void {
    if (!this.ctx) return;
    let r = this.receivers.get(d.sessionId);
    if (!r) {
      const sid = d.sessionId;
      const meta: Receiver['meta'] = [];
      const dec = new AudioDecoder({
        output: (data) => this.onDecoded(sid, data),
        error: () => { this.receivers.delete(sid); },
      });
      dec.configure({ codec: 'opus', sampleRate: 48000, numberOfChannels: 1 });
      r = { dec, meta, lastVoice: 0, got: 0, first: null, last: 0 };
      this.receivers.set(sid, r);
    }
    if (d.voice) r.lastVoice = performance.now();
    this.countLoss(r, d.seq);
    r.meta.push({ seq: d.seq, ts: d.timestamp, flags: d.flags });
    try {
      r.dec.decode(new EncodedAudioChunk({ type: 'key', timestamp: r.meta.length + d.seq, data: d.payload }));
    } catch {
      r.meta.pop();
    }
  }

  private countLoss(r: Receiver, seq: number): void {
    r.got++;
    if (r.first === null) r.first = seq;
    r.last = seq;
    const span = ((r.last - r.first) & 0xffff) + 1;
    if (span >= 250) { // ~5 s
      const lost = Math.max(0, 1 - r.got / span) * 100;
      this.loss = this.loss * 0.5 + lost * 0.5;
      r.got = 0;
      r.first = null;
    }
  }

  private onDecoded(sid: number, data: AudioData): void {
    const r = this.receivers.get(sid);
    const m = r?.meta.shift();
    if (!m) { data.close(); return; }
    const pcm = new Float32Array(FRAME_SAMPLES);
    try {
      const n = Math.min(data.numberOfFrames, FRAME_SAMPLES);
      const tmp = new Float32Array(data.numberOfFrames);
      data.copyTo(tmp, { planeIndex: 0, format: 'f32-planar' });
      pcm.set(tmp.subarray(0, n));
    } catch {
      // A browser that can't convert: s16.
      try {
        const s16 = new Int16Array(data.numberOfFrames * data.numberOfChannels);
        data.copyTo(s16, { planeIndex: 0 });
        for (let i = 0; i < FRAME_SAMPLES && i < s16.length; i++) pcm[i] = s16[i * data.numberOfChannels]! / 32768;
      } catch { /* silence */ }
    } finally {
      data.close();
    }
    const frame: JitterFrame = { seq: m.seq, ts: m.ts, flags: m.flags, pcm };
    this.mixer?.port.postMessage({ type: 'frame', sid, frame } satisfies MixerMessage, [pcm.buffer]);
  }

  private onPlayout(at: number, playing: Array<{ sid: number; ts: number }>): void {
    const ctx = this.ctx;
    if (!ctx) return;
    // Audio clock → Unix µs: the context's output timestamp, plus the
    // output latency to the speaker.
    const o = ctx.getOutputTimestamp?.();
    const perf = o?.performanceTime !== undefined && o.contextTime !== undefined
      ? o.performanceTime + (at - o.contextTime) * 1000
      : performance.now() + (at - ctx.currentTime) * 1000;
    const latencyMs = ((ctx as AudioContext & { outputLatency?: number }).outputLatency ?? ctx.baseLatency ?? 0) * 1000;
    const localUS = Math.round((performance.timeOrigin + perf + latencyMs) * 1000);
    const seen = new Set<number>();
    for (const p of playing) {
      this.playoutAt.set(p.sid, { ts: p.ts, localUS });
      seen.add(p.sid);
    }
    for (const sid of [...this.playoutAt.keys()]) if (!seen.has(sid)) this.playoutAt.delete(sid);
  }

  // ---- sending ----

  private ensureEncoder(): AudioEncoder | null {
    const key = `${this.bitrate}/${this.music}`;
    if (this.enc && this.enc.state !== 'closed' && this.encConfigured === key) return this.enc;
    if (!this.enc || this.enc.state === 'closed') {
      this.enc = new AudioEncoder({
        output: (chunk) => this.onEncoded(chunk),
        error: () => { this.enc = null; this.encConfigured = ''; this.encMeta = []; },
      });
    }
    const config = {
      codec: 'opus', sampleRate: 48000, numberOfChannels: 1, bitrate: this.bitrate,
      opus: { frameDuration: 20000, useinbandfec: true, packetlossperc: 10, application: this.music ? 'audio' : 'voip' },
    } as AudioEncoderConfig;
    try {
      this.enc.configure(config);
    } catch {
      this.enc.configure({ codec: 'opus', sampleRate: 48000, numberOfChannels: 1, bitrate: this.bitrate });
    }
    this.encConfigured = key;
    return this.enc;
  }

  private onCaptured(frame: Float32Array): void {
    this.lastCapture = performance.now();
    const captureUS = nowUS() - 20_000;
    const level = rmsUnit(frame);
    this.micLevel = level;
    if (level > 0) this.lastSound = this.lastCapture;
    const voiced = level >= this.vad;
    if (voiced) this.hang = VAD_HANGOVER;
    else if (this.hang > 0) this.hang--;
    let want = this.ptt ? this.pttDown : this.hang > 0 || this.music;
    if (this.muted) want = false;
    let flags = 0;
    if (want && !this.sending) flags = FLAG_START;
    else if (!want && this.sending) flags = FLAG_END;
    else if (!want) {
      this.ts = (this.ts + FRAME_SAMPLES) >>> 0;
      this.transmitting = false;
      return;
    }
    this.sending = want;
    this.transmitting = want;
    const enc = this.ensureEncoder();
    if (!enc || enc.encodeQueueSize > 4) {
      this.ts = (this.ts + FRAME_SAMPLES) >>> 0;
      return;
    }
    this.encMeta.push({ seq: this.seq, ts: this.ts, flags, voice: voiced || this.hang > 0, level: unitToLevel(level), captureUS });
    const data = new AudioData({ format: 'f32-planar', sampleRate: 48000, numberOfFrames: FRAME_SAMPLES, numberOfChannels: 1, timestamp: captureUS, data: frame as Float32Array<ArrayBuffer> });
    enc.encode(data);
    data.close();
    this.seq = (this.seq + 1) & 0xffff;
    this.ts = (this.ts + FRAME_SAMPLES) >>> 0;
  }

  private onEncoded(chunk: EncodedAudioChunk): void {
    const m = this.encMeta.shift();
    if (!m) return;
    const payload = new Uint8Array(chunk.byteLength);
    chunk.copyTo(payload);
    const u = { flags: m.flags, voice: m.voice, level: m.level, seq: m.seq, timestamp: m.ts, payload };
    const s = this.sender;
    if (s) {
      try { s.sendAudio(u); } catch { /* too big / closed */ }
      const now = performance.now();
      if (m.flags === FLAG_START || now - this.lastReport >= CLOCK_REPORT_MS) {
        this.lastReport = now;
        void Promise.resolve(s.audioClock(m.ts, m.captureUS)).catch(() => {});
      }
    }
    if (this.loopback) {
      this.handleAudio({ ...u, payload: payload.slice(), targetKind: 0, sessionId: LOOPBACK_SESSION });
    }
  }

  private post(m: MixerMessage): void {
    this.mixer?.port.postMessage(m);
  }
}
