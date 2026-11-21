import { describe, expect, it } from 'vitest';
import { FLAG_END, FLAG_START, FRAME_SAMPLES, JitterBuffer, seqDiff } from './jitter';
import { Mixer, Resampler, softLimit } from './mixer';
import { AvClock, unwrap } from './avsync';

const frame = (seq: number, v = 0.1, flags = 0, ts = seq * FRAME_SAMPLES) => ({ seq: seq & 0xffff, ts: ts >>> 0, flags, pcm: new Float32Array(FRAME_SAMPLES).fill(v) });

describe('seqDiff', () => {
  it('wraps', () => {
    expect(seqDiff(65535, 0)).toBe(1);
    expect(seqDiff(0, 65535)).toBe(-1);
    expect(seqDiff(10, 15)).toBe(5);
  });
});

describe('JitterBuffer', () => {
  it('buffers to the target, then plays in order', () => {
    const jb = new JitterBuffer(3);
    const out = new Float32Array(FRAME_SAMPLES);
    jb.push(frame(1, 0.1, FLAG_START));
    jb.push(frame(3, 0.3));
    expect(jb.pop(out)).toBe(false); // 2 < target
    jb.push(frame(2, 0.2));
    expect(jb.pop(out)).toBe(true);
    expect(out[0]).toBeCloseTo(0.1);
    out.fill(0);
    jb.pop(out);
    expect(out[0]).toBeCloseTo(0.2);
    expect(jb.popTS).toBe(2 * FRAME_SAMPLES);
  });

  it('conceals a missing frame with silence and moves the timestamp on', () => {
    const jb = new JitterBuffer(1);
    const out = new Float32Array(FRAME_SAMPLES);
    jb.push(frame(1, 0.5, FLAG_START));
    expect(jb.pop(out)).toBe(true);
    jb.push(frame(3, 0.5));
    out.fill(0);
    expect(jb.pop(out)).toBe(true); // seq 2: concealed
    expect(out[0]).toBe(0);
    expect(jb.popTS).toBe(2 * FRAME_SAMPLES);
    expect(jb.stats.concealed).toBe(1);
    jb.pop(out);
    expect(jb.stats.played).toBe(2);
  });

  it('drops late frames and ends at a spurt end', () => {
    const jb = new JitterBuffer(1);
    const out = new Float32Array(FRAME_SAMPLES);
    jb.push(frame(5, 0.1, FLAG_START));
    jb.pop(out);
    jb.push(frame(4));
    expect(jb.stats.late).toBe(1);
    jb.push(frame(6, 0.1, FLAG_END));
    expect(jb.pop(out)).toBe(true);
    expect(jb.pop(out)).toBe(false); // idle after the end
  });

  it('gives up after too many concealed frames', () => {
    const jb = new JitterBuffer(1);
    const out = new Float32Array(FRAME_SAMPLES);
    jb.push(frame(1, 0.1, FLAG_START));
    jb.pop(out);
    let played = 0;
    for (let i = 0; i < 12; i++) if (jb.pop(out)) played++;
    expect(played).toBe(10);
    expect(jb.pop(out)).toBe(false);
  });

  it('skips ahead when it runs long, and re-buffers on a new spurt', () => {
    const jb = new JitterBuffer(2);
    const out = new Float32Array(FRAME_SAMPLES);
    for (let s = 0; s < 12; s++) jb.push(frame(s, 0.1, s === 0 ? FLAG_START : 0));
    jb.pop(out);
    expect(jb.stats.dropped).toBeGreaterThan(0);
    expect(jb.depth()).toBeLessThanOrEqual(2 + 4);
    jb.push(frame(100, 0.1, FLAG_START));
    expect(jb.pop(out)).toBe(false);
  });

  it('adds extra delay (lip sync) before playing', () => {
    const jb = new JitterBuffer(1);
    jb.extra = 2;
    const out = new Float32Array(FRAME_SAMPLES);
    jb.push(frame(1, 0.1, FLAG_START));
    jb.push(frame(2));
    expect(jb.pop(out)).toBe(false);
    jb.push(frame(3));
    expect(jb.pop(out)).toBe(true);
  });
});

describe('Mixer', () => {
  it('mixes senders with their gains, deafens, reports what plays', () => {
    const m = new Mixer(1);
    m.push(1, frame(1, 0.2, FLAG_START, 1000));
    m.push(2, frame(7, 0.1, FLAG_START, 5000));
    m.setGain(2, 2);
    const out = new Float32Array(FRAME_SAMPLES);
    m.mixFrame(out);
    expect(out[0]).toBeCloseTo(0.4);
    expect(m.playing()).toEqual([{ sid: 1, ts: 1000 }, { sid: 2, ts: 5000 }]);
    m.deafened = true;
    m.push(1, frame(2, 0.2));
    m.mixFrame(out);
    expect(out[0]).toBe(0);
    m.remove(1);
    expect(m.stats().has(1)).toBe(false);
  });

  it('keeps gains and delays for senders that join later', () => {
    const m = new Mixer(1);
    m.setGain(9, 0.5);
    m.setDelay(9, 1);
    m.push(9, frame(1, 0.4, FLAG_START));
    const out = new Float32Array(FRAME_SAMPLES);
    m.mixFrame(out);
    expect(out[0]).toBe(0); // waiting one extra frame
    m.push(9, frame(2, 0.4));
    m.mixFrame(out);
    expect(out[0]).toBeCloseTo(0.2);
  });

  it('soft-limits loud mixes', () => {
    expect(softLimit(0.5)).toBe(0.5);
    expect(softLimit(3)).toBeLessThan(1);
    expect(softLimit(-3)).toBeGreaterThan(-1);
  });
});

describe('Resampler', () => {
  it('passes through at the same rate and converts 48k → 44.1k', () => {
    const same = new Resampler(48000, 48000);
    const x = new Float32Array([1, 2, 3]);
    expect(same.process(x)).toBe(x);
    const r = new Resampler(48000, 44100);
    let n = 0;
    for (let i = 0; i < 100; i++) n += r.process(new Float32Array(960).fill(0.5)).length;
    expect(Math.abs(n - 96000 * 44100 / 48000)).toBeLessThan(3);
  });
});

describe('AvClock', () => {
  it('unwraps 32-bit timestamps', () => {
    expect(unwrap(5, 0xfffffff0)).toBe(0x100000005);
  });

  it('maps timestamps to the sender wall clock at the nominal rate', () => {
    const c = new AvClock();
    expect(c.wallUS(0)).toBeNull();
    c.report(48000, 1_000_000);
    expect(c.wallUS(96000)).toBe(2_000_000);
    expect(c.have()).toBe(true);
  });

  it('fits drift over reports and restarts on a new clock', () => {
    const c = new AvClock();
    for (let i = 0; i <= 5; i++) c.report(i * 48048, 1_000_000 + i * 1_000_000); // 1000 ppm fast
    const w = c.wallUS(6 * 48048)!;
    expect(Math.abs(w - 7_000_000)).toBeLessThan(2000);
    c.report(5, 100_000_000); // far off: a restarted sender
    expect(c.wallUS(48005)).toBe(101_000_000);
  });
});
