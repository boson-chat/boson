import { describe, it, expect, vi } from 'vitest';
import { VideoController, type VideoEnv } from './video.controller';
import type { VideoBridge } from './video.bridge';
import { EMPTY_VIDEO_STATE, type VideoState } from './video.types';
import { codecFromDesc, parseBinary, parseText } from './video.frames';
import { layerForTile } from './video.layout';

// ---- fakes ----

class FakeSocket {
  static last: FakeSocket | null = null;
  binaryType = '';
  readyState = 1;
  sent: string[] = [];
  closed = false;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  constructor(readonly url: string) { FakeSocket.last = this; }
  send(s: string) { this.sent.push(s); }
  close() { this.closed = true; }
  recv(data: unknown) { this.onmessage?.({ data }); }
}

class FakeFrame {
  closed = false;
  displayWidth = 640;
  displayHeight = 360;
  constructor(readonly timestamp: number) {}
  close() { this.closed = true; }
}

class FakeDecoder {
  static all: FakeDecoder[] = [];
  state: 'unconfigured' | 'configured' | 'closed' = 'unconfigured';
  config: { codec: string; description: Uint8Array } | null = null;
  decoded: { type: string; timestamp: number }[] = [];
  constructor(private init: { output: (f: FakeFrame) => void; error: (e: unknown) => void }) { FakeDecoder.all.push(this); }
  configure(c: { codec: string; description: Uint8Array }) { this.config = c; this.state = 'configured'; }
  decode(chunk: { type: string; timestamp: number }) {
    this.decoded.push(chunk);
    this.init.output(new FakeFrame(chunk.timestamp)); // decodes at once
  }
  fail() { this.init.error(new Error('boom')); }
  close() { this.state = 'closed'; }
}

class FakeChunk {
  type: string;
  timestamp: number;
  constructor(init: { type: string; timestamp: number }) { this.type = init.type; this.timestamp = init.timestamp; }
}

function frameMsg(trackId: number, captureUS: number, opts: { key?: boolean; desc?: number[] } = {}): ArrayBuffer {
  const desc = opts.desc ? Uint8Array.from(opts.desc) : new Uint8Array();
  const data = Uint8Array.from([0, 0, 0, 1, 0x65]);
  const b = new Uint8Array(20 + desc.length + data.length);
  const v = new DataView(b.buffer);
  b[0] = 1;
  b[1] = (opts.key ? 1 : 0) | (opts.desc ? 2 : 0);
  v.setUint32(2, trackId);
  v.setUint32(6, 1);
  v.setBigUint64(10, BigInt(captureUS));
  v.setUint16(18, desc.length);
  b.set(desc, 20);
  b.set(data, 20 + desc.length);
  return b.buffer;
}

const DESC = [1, 0x42, 0xc0, 0x1e, 0xff, 0xe1, 0, 1, 0x67, 1, 0, 1, 0x68];

const TRACK = {
  trackId: 10, userId: 'usr_alice', name: 'alice', kind: 'camera' as const, self: false,
  layers: [{ id: 0, width: 320, height: 180, fps: 15 }, { id: 1, width: 640, height: 360, fps: 30 }, { id: 2, width: 1280, height: 720, fps: 30 }],
};

function setup(state: Partial<VideoState> = {}) {
  FakeDecoder.all = [];
  FakeSocket.last = null;
  let onState: ((s: VideoState) => void) | null = null;
  const full: VideoState = { ...EMPTY_VIDEO_STATE, available: true, status: 'connected', frameUrl: 'ws://127.0.0.1:1/video?k=x', tracks: [TRACK], ...state };
  const bridge: VideoBridge = {
    state: vi.fn(async () => full),
    onState: (fn) => { onState = fn; return () => { onState = null; }; },
    subscribe: vi.fn(async () => {}),
    unsubscribe: vi.fn(async () => {}),
    cameras: vi.fn(async () => []),
    screenSources: vi.fn(async () => []),
    setCamera: vi.fn(async () => full),
    setScreen: vi.fn(async () => full),
    resumeCamera: vi.fn(async () => full),
  };
  let now = 1_000_000;
  const env: Partial<VideoEnv> = {
    WebSocket: FakeSocket as unknown as typeof WebSocket,
    VideoDecoder: FakeDecoder as unknown as typeof VideoDecoder,
    EncodedVideoChunk: FakeChunk as unknown as typeof EncodedVideoChunk,
    now: () => now,
    raf: () => 1,
    cancelRaf: () => {},
  };
  const c = new VideoController(bridge, env);
  return { c, bridge, push: (s: VideoState) => onState?.(s), full, setNow: (n: number) => { now = n; } };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

// ---- tests ----

describe('frame messages', () => {
  it('parses frames, previews and sync, and builds codec strings', () => {
    const f = parseBinary(frameMsg(7, 1_800_000_000_123_456, { key: true, desc: DESC }));
    expect(f).toMatchObject({ kind: 'frame', keyframe: true, trackId: 7, layer: 1, captureUS: 1_800_000_000_123_456 });
    expect(Array.from((f as { desc: Uint8Array }).desc)).toEqual(DESC);
    expect(codecFromDesc(Uint8Array.from(DESC))).toBe('avc1.42c01e');
    expect(codecFromDesc(undefined)).toBe('avc1.42e01f');

    const p = new Uint8Array(5 + 2 * 1 * 4);
    p.set([2, 0, 2, 0, 1]);
    expect(parseBinary(p.buffer)).toMatchObject({ kind: 'preview', width: 2, height: 1 });
    expect(parseBinary(new Uint8Array([9]).buffer)).toBeNull();

    expect(parseText('{"type":"sync","offsets":{"10":-1500}}')?.offsets.get(10)).toBe(-1500);
    expect(parseText('nope')).toBeNull();
  });
});

describe('layout', () => {
  it('picks the layer that fits a tile, or none when hidden', () => {
    expect(layerForTile(TRACK.layers, 300, 170, true)).toBe(0);
    expect(layerForTile(TRACK.layers, 640, 360, true)).toBe(1);
    expect(layerForTile(TRACK.layers, 2560, 1440, true)).toBe(2);
    expect(layerForTile(TRACK.layers, 640, 360, false)).toBeNull();
  });
});

describe('VideoController', () => {
  it('only receives while the call view is open', async () => {
    const { c, bridge } = setup();
    await flush();
    expect(FakeSocket.last).toBeNull();
    c.tiles([{ trackId: 10, width: 640, height: 360, visible: true }]);
    expect(bridge.subscribe).not.toHaveBeenCalled();

    c.setOpen(true);
    expect(FakeSocket.last?.url).toBe('ws://127.0.0.1:1/video?k=x');
    c.tiles([{ trackId: 10, width: 640, height: 360, visible: true }]);
    c.tiles([{ trackId: 10, width: 640, height: 360, visible: true }]); // same: not again
    expect(bridge.subscribe).toHaveBeenCalledTimes(1);
    expect(bridge.subscribe).toHaveBeenCalledWith(10, 1);
    c.tiles([{ trackId: 10, width: 1920, height: 1080, visible: true }]);
    expect(bridge.subscribe).toHaveBeenLastCalledWith(10, 2);

    c.setOpen(false);
    expect(bridge.unsubscribe).toHaveBeenCalledWith(10);
    expect(FakeSocket.last?.closed).toBe(true);
  });

  it('never subscribes to our own track', async () => {
    const { c, bridge } = setup({ tracks: [{ ...TRACK, self: true }] });
    await flush();
    c.setOpen(true);
    c.tiles([{ trackId: 10, width: 640, height: 360, visible: true }]);
    expect(bridge.subscribe).not.toHaveBeenCalled();
  });

  it('decodes from a keyframe with its description, and asks for one otherwise', async () => {
    const { c } = setup();
    await flush();
    c.setOpen(true);
    const ws = FakeSocket.last!;
    ws.recv(frameMsg(10, 1000, {})); // a delta before any keyframe: no decoder yet
    expect(ws.sent).toEqual(['{"type":"keyframe","trackId":10}']);
    ws.recv(frameMsg(10, 2000, { key: true, desc: DESC }));
    expect(FakeDecoder.all).toHaveLength(1);
    expect(FakeDecoder.all[0].config?.codec).toBe('avc1.42c01e');
    ws.recv(frameMsg(10, 3000, {}));
    expect(FakeDecoder.all[0].decoded.map((d) => d.type)).toEqual(['key', 'delta']);
    // Same description again: same decoder. A new one: reconfigured.
    ws.recv(frameMsg(10, 4000, { key: true, desc: DESC }));
    expect(FakeDecoder.all).toHaveLength(1);
    ws.recv(frameMsg(10, 5000, { key: true, desc: [...DESC.slice(0, 3), 0x1f, ...DESC.slice(4)] }));
    expect(FakeDecoder.all).toHaveLength(2);

    // A decoder error: start over at the next keyframe.
    FakeDecoder.all[1].fail();
    expect(c.stats()[10].decoded).toBe(4);
  });

  it('shows each frame with its audio (capture time + offset), dropping overdue ones', async () => {
    const { c, setNow } = setup();
    await flush();
    c.setOpen(true);
    const ws = FakeSocket.last!;
    const canvas = document.createElement('canvas');
    const ctx = { clearRect: vi.fn(), drawImage: vi.fn() };
    canvas.getContext = (() => ctx) as unknown as typeof canvas.getContext;
    c.attachCanvas(10, canvas);

    // Audio for alice plays 250 ms after her capture time (local clock
    // minus her clock, in µs).
    const T = 1_800_000_000_000_000; // her capture µs
    ws.recv('{"type":"sync","offsets":{"10":' + (1_000_000_000 - T / 1000 + 250) * 1000 + '}}');
    // Local clock now = 1_000_000_000 ms; frames captured at T, T+33ms, T+66ms.
    ws.recv(frameMsg(10, T, { key: true, desc: DESC }));
    ws.recv(frameMsg(10, T + 33_000, {}));
    ws.recv(frameMsg(10, T + 66_000, {}));

    setNow(1_000_000_000 + 200); // before the first is due
    c.renderFrame();
    expect(ctx.drawImage).not.toHaveBeenCalled();

    setNow(1_000_000_000 + 250 + 40); // first two due: the older is dropped
    c.renderFrame();
    expect(ctx.drawImage).toHaveBeenCalledTimes(1);
    let s = c.stats()[10];
    expect(s.dropped).toBe(1);
    expect(s.synced).toBe(true);
    expect(s.lastSkewMs).toBeCloseTo(7, 0); // shown 7 ms after its sound

    setNow(1_000_000_000 + 250 + 66);
    c.renderFrame();
    s = c.stats()[10];
    expect(s.shown).toBe(2);
    expect(s.lastSkewMs).toBeCloseTo(0, 0);
  });

  it('shows frames as they come without an audio offset', async () => {
    const { c } = setup();
    await flush();
    c.setOpen(true);
    const ws = FakeSocket.last!;
    ws.recv(frameMsg(10, 5, { key: true, desc: DESC }));
    c.renderFrame();
    const s = c.stats()[10];
    expect(s.shown).toBe(1);
    expect(s.synced).toBe(false);
    expect(s.lastSkewMs).toBeNull();
  });

  it("doesn't let the first state answer overwrite a newer pushed state", async () => {
    const { c, push, full } = setup();
    push({ ...full, tracks: [] });
    await flush(); // bridge.state() resolves now, with the older state
    expect(c.getSnapshot().state.tracks).toEqual([]);
  });

  it('defaults the big tile to the newest screen, and forgets gone tracks', async () => {
    const screen = { ...TRACK, trackId: 11, kind: 'screen' as const };
    const { c, push, full } = setup({ tracks: [TRACK, screen] });
    await flush();
    expect(c.bigTile()).toBe(11);
    c.pin(10);
    expect(c.bigTile()).toBe(10);
    c.pin(10);
    expect(c.bigTile()).toBe(11);
    c.pin(10);
    push({ ...full, tracks: [screen] });
    expect(c.getSnapshot().pinned).toBe(0);
  });
});

describe('camera resume', () => {
  const setVisibility = (v: 'visible' | 'hidden') => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => v });
    document.dispatchEvent(new Event('visibilitychange'));
  };

  it('asks Go to turn a paused camera back on when the page is shown again', async () => {
    const { c, bridge, push, full } = setup();
    await flush();
    push({ ...full, camera: { on: false, starting: false, paused: true, id: 'front' } });
    setVisibility('hidden');
    expect(bridge.resumeCamera).not.toHaveBeenCalled();
    setVisibility('visible');
    expect(bridge.resumeCamera).toHaveBeenCalledTimes(1);
    c.dispose();
  });

  it('does nothing when the camera is off or running, or after dispose', async () => {
    const { c, bridge, push, full } = setup();
    await flush();
    push({ ...full, camera: { on: false, starting: false } });
    setVisibility('visible');
    push({ ...full, camera: { on: true, starting: false } });
    setVisibility('visible');
    expect(bridge.resumeCamera).not.toHaveBeenCalled();
    push({ ...full, camera: { on: false, starting: false, paused: true } });
    c.dispose();
    setVisibility('visible');
    expect(bridge.resumeCamera).not.toHaveBeenCalled();
  });
});

describe('errors in the video path', () => {
  it("don't stop the render loop, and are reported to Go over the frame socket", async () => {
    const ticks: (() => void)[] = [];
    const { c } = setup();
    (c as unknown as { env: { raf: (f: () => void) => number } }).env.raf = (f) => { ticks.push(f); return ticks.length; };
    await flush();
    c.setOpen(true);
    const ws = FakeSocket.last!;
    const canvas = document.createElement('canvas');
    let calls = 0;
    canvas.getContext = (() => ({ clearRect() {}, drawImage() { calls++; throw new Error('draw failed'); } })) as unknown as typeof canvas.getContext;
    c.attachCanvas(10, canvas);
    ws.recv(frameMsg(10, 1, { key: true, desc: DESC }));
    ticks.at(-1)!(); // renders: draw throws
    ws.recv(frameMsg(10, 2));
    ticks.at(-1)!(); // the loop is still scheduled and renders again
    expect(calls).toBe(2);
    const logs = ws.sent.map((s) => JSON.parse(s)).filter((m) => m.type === 'log');
    expect(logs.length).toBe(2);
    expect(logs[0].where).toBe('render');
    expect(logs[0].msg).toContain('draw failed');
    // A message that breaks the handler is reported too, and later ones still work.
    ws.recv(new ArrayBuffer(0));
    ws.recv('{"type":"sync","offsets":{"10":5}}');
  });
});

describe('screen shares', () => {
  const SCREEN = { trackId: 20, userId: 'usr_bob', name: 'bob', kind: 'screen' as const, self: false,
    layers: [{ id: 0, width: 1280, height: 800, fps: 15 }, { id: 1, width: 1920, height: 1200, fps: 30 }] };

  it('take their top (30 fps) layer even on a small tile; cameras go by size', async () => {
    const { c, bridge } = setup({ tracks: [TRACK, SCREEN] });
    await flush();
    c.setOpen(true);
    c.tiles([{ trackId: 20, width: 378 * 3, height: 213 * 3, visible: true }, { trackId: 10, width: 378 * 3, height: 213 * 3, visible: true }]);
    expect(bridge.subscribe).toHaveBeenCalledWith(20, 1);
    expect(bridge.subscribe).toHaveBeenCalledWith(10, 2);
    c.tiles([{ trackId: 20, width: 378, height: 213, visible: false }]);
    expect(bridge.unsubscribe).toHaveBeenCalledWith(20);
  });
});
