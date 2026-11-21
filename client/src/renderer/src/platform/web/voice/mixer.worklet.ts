/// <reference path="./worklet-types.d.ts" />
// Playback (AudioWorklet): decoded frames from every sender go into the
// mixer's jitter buffers; 20 ms mixed frames are resampled to the
// device's rate and played. Every 100 ms it reports which sender
// timestamps are playing at which audio clock time (lip sync).
import { FRAME_SAMPLES, type JitterFrame } from './jitter';
import { Mixer, Resampler } from './mixer';

export type MixerMessage =
  | { type: 'frame'; sid: number; frame: JitterFrame }
  | { type: 'remove'; sid: number }
  | { type: 'gain'; sid: number; gain: number }
  | { type: 'delay'; sid: number; frames: number }
  | { type: 'deafen'; on: boolean }
  | { type: 'stop' };

class MixerProcessor extends AudioWorkletProcessor {
  private mix = new Mixer(3);
  private rs = new Resampler(48000, sampleRate);
  private fifo = new Float32Array(0);
  private frame = new Float32Array(FRAME_SAMPLES);
  private frames = 0;
  private on = true;

  constructor() {
    super();
    this.port.onmessage = (ev: MessageEvent<MixerMessage>) => {
      const m = ev.data;
      switch (m.type) {
        case 'frame': this.mix.push(m.sid, m.frame); break;
        case 'remove': this.mix.remove(m.sid); break;
        case 'gain': this.mix.setGain(m.sid, m.gain); break;
        case 'delay': this.mix.setDelay(m.sid, m.frames); break;
        case 'deafen': this.mix.deafened = m.on; break;
        case 'stop': this.on = false; break;
      }
    };
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const out = outputs[0]?.[0];
    if (!out) return this.on;
    while (this.fifo.length < out.length) {
      // The first sample of this frame plays after what's queued.
      const at = currentTime + this.fifo.length / sampleRate;
      this.mix.mixFrame(this.frame);
      const res = this.rs.process(this.frame);
      const nf = new Float32Array(this.fifo.length + res.length);
      nf.set(this.fifo);
      nf.set(res, this.fifo.length);
      this.fifo = nf;
      if (++this.frames % 5 === 0) {
        const playing = this.mix.playing();
        const stats = [...this.mix.stats()].map(([sid, s]) => ({ sid, ...s }));
        this.port.postMessage({ type: 'playout', at, playing, stats });
      }
    }
    out.set(this.fifo.subarray(0, out.length));
    for (let c = 1; c < outputs[0]!.length; c++) outputs[0]![c]!.set(out);
    this.fifo = this.fifo.slice(out.length);
    return this.on;
  }
}

registerProcessor('boson-mixer', MixerProcessor);
