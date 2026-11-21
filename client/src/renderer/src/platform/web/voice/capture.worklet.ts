/// <reference path="./worklet-types.d.ts" />
// Mic capture (AudioWorklet): the input resampled to 48 kHz mono and cut
// into 20 ms frames (960 samples), each posted with the audio clock time
// of its last sample.
import { FRAME_SAMPLES } from './jitter';
import { Resampler } from './mixer';

class CaptureProcessor extends AudioWorkletProcessor {
  private rs = new Resampler(sampleRate, 48000);
  private frame = new Float32Array(FRAME_SAMPLES);
  private n = 0;
  private on = true;

  constructor() {
    super();
    this.port.onmessage = (ev: MessageEvent<{ type: string }>) => {
      if (ev.data?.type === 'stop') this.on = false;
    };
  }

  process(inputs: Float32Array[][]): boolean {
    const ch = inputs[0]?.[0];
    if (!ch) return this.on;
    const s = this.rs.process(ch);
    for (let i = 0; i < s.length; i++) {
      this.frame[this.n++] = s[i]!;
      if (this.n === FRAME_SAMPLES) {
        const out = this.frame;
        this.port.postMessage({ pcm: out, at: currentTime }, [out.buffer]);
        this.frame = new Float32Array(FRAME_SAMPLES);
        this.n = 0;
      }
    }
    return this.on;
  }
}

registerProcessor('boson-capture', CaptureProcessor);
