// One sender's jitter buffer: a port of quicvoice client/voice jitter.go
// for the web build. It holds DECODED frames (WebCodecs decodes on
// arrival, it has no FEC/PLC call), reorders them by sequence number and
// plays a steady 20 ms stream: re-buffers at each talk spurt's start,
// skips ahead when it runs long, and conceals a missing frame with
// silence (up to MAX_CONCEALED in a row, then the sender counts as gone).
// Runs inside the mixer's AudioWorklet (mixer.ts).

export const FRAME_SAMPLES = 960; // 20 ms at 48 kHz
export const FLAG_START = 1;
export const FLAG_END = 2;
const RING = 64;
const MAX_CONCEALED = 10;

export interface JitterFrame {
  seq: number; // u16
  ts: number; // u32, 48 kHz
  flags: number;
  pcm: Float32Array; // FRAME_SAMPLES samples
}

export interface JitterStats {
  received: number;
  played: number;
  concealed: number;
  late: number;
  dropped: number;
  depth: number;
}

type State = 'idle' | 'buffering' | 'playing';

/** b - a in u16 sequence space. */
export function seqDiff(a: number, b: number): number {
  return (((b - a) & 0xffff) << 16) >> 16;
}

export class JitterBuffer {
  private ring: (JitterFrame | null)[] = new Array(RING).fill(null);
  private state: State = 'idle';
  private next = 0;
  private concealedRun = 0;
  extra = 0; // frames of added delay (lip sync), from the next spurt
  popTS = 0;
  popTSSet = false;
  stats: Omit<JitterStats, 'depth'> = { received: 0, played: 0, concealed: 0, late: 0, dropped: 0 };

  constructor(public target = 3) {}

  push(f: JitterFrame): void {
    if (f.flags & FLAG_START && this.state === 'playing') this.reset();
    switch (this.state) {
      case 'idle':
        this.state = 'buffering';
        this.next = f.seq;
        break;
      case 'buffering':
        if (seqDiff(this.next, f.seq) < 0) this.next = f.seq;
        break;
      case 'playing': {
        const ahead = seqDiff(this.next, f.seq);
        if (ahead < 0) {
          this.stats.late++;
          return;
        }
        if (ahead >= RING) {
          this.reset();
          this.state = 'buffering';
          this.next = f.seq;
        }
        break;
      }
    }
    this.ring[f.seq % RING] = f;
    this.stats.received++;
  }

  /** The next 20 ms into out (added, scaled by gain); false when silent. */
  pop(out: Float32Array, gain = 1): boolean {
    if (this.state === 'idle') return false;
    if (this.state === 'buffering') {
      if (this.depth() < this.target + this.extra) return false;
      this.state = 'playing';
    }
    while (this.depth() > this.target + this.extra + 4) {
      if (this.slot(this.next)) {
        this.ring[this.next % RING] = null;
        this.stats.dropped++;
      }
      this.next = (this.next + 1) & 0xffff;
    }
    let played = true;
    const s = this.slot(this.next);
    if (s) {
      this.popTS = s.ts;
      this.popTSSet = true;
      const n = Math.min(out.length, s.pcm.length);
      for (let i = 0; i < n; i++) out[i]! += s.pcm[i]! * gain;
      this.ring[this.next % RING] = null;
      this.concealedRun = 0;
      this.stats.played++;
      if (s.flags & FLAG_END) {
        this.reset();
        return true;
      }
    } else {
      // Missing: silence stands in for it, 20 ms after the last one.
      if (this.popTSSet) this.popTS = (this.popTS + FRAME_SAMPLES) >>> 0;
      this.concealedRun++;
      this.stats.concealed++;
      if (this.concealedRun > MAX_CONCEALED) {
        this.reset();
        played = false;
      }
    }
    this.next = (this.next + 1) & 0xffff;
    return played;
  }

  depth(): number {
    let n = 0;
    for (const s of this.ring) if (s && seqDiff(this.next, s.seq) >= 0) n++;
    return n;
  }

  snapshot(): JitterStats {
    return { ...this.stats, depth: this.depth() };
  }

  private slot(seq: number): JitterFrame | null {
    const s = this.ring[seq % RING];
    return s && s.seq === seq ? s : null;
  }

  private reset(): void {
    this.ring.fill(null);
    this.state = 'idle';
    this.concealedRun = 0;
  }
}
