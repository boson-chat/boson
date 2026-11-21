// The mixer (quicvoice client/voice mixer.go, for the web build): one
// jitter buffer per sender, per-user gain, deafen, a soft limiter, and
// which sender timestamps are playing (lip sync). Pure logic: it runs in
// mixer.worklet.ts at 48 kHz frames; the worklet resamples to the
// device's rate.
import { FRAME_SAMPLES, JitterBuffer, type JitterFrame, type JitterStats } from './jitter';

interface Stream {
  jb: JitterBuffer;
  gain: number;
  curTS: number;
  curOK: boolean;
}

export class Mixer {
  private streams = new Map<number, Stream>();
  private gains = new Map<number, number>();
  private delays = new Map<number, number>();
  private acc = new Float32Array(FRAME_SAMPLES);
  master = 1;
  deafened = false;

  constructor(private target = 3) {}

  push(sid: number, f: JitterFrame): void {
    let s = this.streams.get(sid);
    if (!s) {
      s = { jb: new JitterBuffer(this.target), gain: this.gains.get(sid) ?? 1, curTS: 0, curOK: false };
      s.jb.extra = this.delays.get(sid) ?? 0;
      this.streams.set(sid, s);
    }
    s.jb.push(f);
  }

  remove(sid: number): void {
    this.streams.delete(sid);
  }

  setGain(sid: number, gain: number): void {
    const g = Math.min(Math.max(gain, 0), 2);
    this.gains.set(sid, g);
    const s = this.streams.get(sid);
    if (s) s.gain = g;
  }

  /** Extra playout delay in frames (lip sync), from the sender's next spurt. */
  setDelay(sid: number, frames: number): void {
    this.delays.set(sid, frames);
    const s = this.streams.get(sid);
    if (s) s.jb.extra = frames;
  }

  /** Mixes the next 20 ms frame into out (FRAME_SAMPLES). */
  mixFrame(out: Float32Array): void {
    this.acc.fill(0);
    for (const s of this.streams.values()) {
      s.curOK = false;
      if (!s.jb.pop(this.acc, s.gain)) continue;
      s.curTS = s.jb.popTS;
      s.curOK = s.jb.popTSSet;
    }
    if (this.deafened) {
      out.fill(0);
      return;
    }
    for (let i = 0; i < FRAME_SAMPLES; i++) out[i] = softLimit(this.acc[i]! * this.master);
  }

  /** Senders playing in the current frame: their frame's audio timestamp. */
  playing(): Array<{ sid: number; ts: number }> {
    const out: Array<{ sid: number; ts: number }> = [];
    for (const [sid, s] of this.streams) if (s.curOK) out.push({ sid, ts: s.curTS });
    return out;
  }

  stats(): Map<number, JitterStats> {
    const out = new Map<number, JitterStats>();
    for (const [sid, s] of this.streams) out.set(sid, s.jb.snapshot());
    return out;
  }
}

/** Linear to 0.8, then bends smoothly towards ±1. */
export function softLimit(x: number): number {
  const knee = 0.8;
  const ax = Math.abs(x);
  if (ax <= knee) return x;
  const y = knee + (1 - knee) * Math.tanh((ax - knee) / (1 - knee));
  return x < 0 ? -y : y;
}

/** Linear-interpolating resampler for a continuous stream (ratio = out/in rate). */
export class Resampler {
  private pos = 0; // fractional read position into the pending input
  private pending = new Float32Array(0);

  constructor(private inRate: number, private outRate: number) {}

  /** Feeds input, returns as many output samples as it can make. */
  process(input: Float32Array): Float32Array {
    if (this.inRate === this.outRate) return input;
    const buf = new Float32Array(this.pending.length + input.length);
    buf.set(this.pending);
    buf.set(input, this.pending.length);
    const step = this.inRate / this.outRate;
    const n = Math.max(0, Math.floor((buf.length - 1 - this.pos) / step) + 1);
    const out = new Float32Array(Math.max(0, n));
    let p = this.pos;
    let k = 0;
    for (; k < n && p < buf.length - 1; k++, p += step) {
      const i = Math.floor(p);
      const f = p - i;
      out[k] = buf[i]! * (1 - f) + buf[i + 1]! * f;
    }
    const consumed = Math.floor(p);
    this.pending = buf.slice(consumed);
    this.pos = p - consumed;
    return out.subarray(0, k);
  }
}
