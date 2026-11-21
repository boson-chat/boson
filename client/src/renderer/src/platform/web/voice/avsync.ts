// A sender's audio clock → wall clock mapping for lip sync: a port of
// quicvoice client/avsync (Go) for the web build. AudioClock reports
// ("audio timestamp T was captured at wall time W", relayed by quicvoiced)
// let any later audio timestamp be turned into the sender's capture time.

const SAMPLE_RATE = 48000;
const KEEP = 16;
const MIN_FIT_SPAN_US = 2_000_000;
const MAX_DRIFT_PPM = 1000;
const RESTART_US = 2_000_000;

interface Point { ts: number; wall: number }

/** x (u32) unwrapped next to ref (within ±2^31 samples). */
export function unwrap(x: number, ref: number): number {
  const d = ((x - ref) | 0); // int32 of the u32 difference
  return ref + d;
}

export class AvClock {
  private pts: Point[] = [];
  private last = 0;

  report(ts: number, wallUS: number): void {
    ts >>>= 0;
    if (this.pts.length === 0) {
      this.last = ts;
      this.pts.push({ ts, wall: wallUS });
      return;
    }
    let u = unwrap(ts, this.last);
    if (Math.abs(this.wallAt(u) - wallUS) > RESTART_US) {
      this.pts = [];
      u = ts;
    }
    this.last = u;
    this.pts.push({ ts: u, wall: wallUS });
    if (this.pts.length > KEEP) this.pts = this.pts.slice(-KEEP);
  }

  have(): boolean {
    return this.pts.length > 0;
  }

  /** The sender's wall clock (Unix µs) when ts was captured; null before any report. */
  wallUS(ts: number): number | null {
    if (this.pts.length === 0) return null;
    return this.wallAt(unwrap(ts >>> 0, this.last));
  }

  private wallAt(u: number): number {
    const n = this.pts.length;
    const newest = this.pts[n - 1]!;
    const nominal = SAMPLE_RATE / 1e6;
    let rate = nominal;
    let anchorTS = newest.ts;
    let anchorWall = newest.wall;
    if (n >= 2 && newest.wall - this.pts[0]!.wall >= MIN_FIT_SPAN_US) {
      let mw = 0;
      let mt = 0;
      for (const p of this.pts) {
        mw += p.wall - newest.wall;
        mt += p.ts - newest.ts;
      }
      mw /= n;
      mt /= n;
      let sxx = 0;
      let sxy = 0;
      for (const p of this.pts) {
        const dw = p.wall - newest.wall - mw;
        const dt = p.ts - newest.ts - mt;
        sxx += dw * dw;
        sxy += dw * dt;
      }
      if (sxx > 0) {
        rate = Math.min(Math.max(sxy / sxx, nominal * (1 - MAX_DRIFT_PPM / 1e6)), nominal * (1 + MAX_DRIFT_PPM / 1e6));
        anchorTS = newest.ts + mt;
        anchorWall = newest.wall + mw;
      }
    }
    return Math.trunc(anchorWall + (u - anchorTS) / rate);
  }
}
