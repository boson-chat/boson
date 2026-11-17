// The call view's video: the VideoService's state (over the bridge), and
// the frames themselves, which come over a loopback WebSocket
// (state.frameUrl) as AVC and are decoded here with WebCodecs.
//
// Lip sync: each frame carries its sender's capture time; the socket also
// carries, per track, the offset at which the sender's audio is playing
// here (desktop/voice.go avOffsets). A frame is shown when
// capture + offset comes round, i.e. with the audio captured at the same
// moment. Without an offset (no audio playing, an old voice server) frames
// show as they arrive.
import { getVoiceSettings } from '../voice/voice.settings';
import type { VideoBridge } from './video.bridge';
import { codecFromDesc, parseBinary, parseText, type FrameMsg } from './video.frames';
import { fitRect, layerForTile } from './video.layout';
import { EMPTY_VIDEO_STATE, type VideoCamera, type VideoSource, type VideoState, type VideoTrack } from './video.types';

export interface VideoSnapshot {
  state: VideoState;
  // The call view is showing (video is only received while it is).
  open: boolean;
  // The big tile: a track id, or 0 for the default (the newest screen).
  pinned: number;
}

// Per-track numbers for the UI and the lip-sync measurement.
export interface TrackStats {
  decoded: number;
  shown: number;
  dropped: number; // decoded but superseded before their time
  // Shown time minus due time of the last synced frame (ms): > 0 means the
  // picture came after its sound.
  lastSkewMs: number | null;
  synced: boolean; // an audio offset is known
}

// Seams for tests: the browser's WebSocket and WebCodecs, the clock and
// the frame scheduler.
export interface VideoEnv {
  WebSocket: typeof WebSocket;
  VideoDecoder: typeof VideoDecoder;
  EncodedVideoChunk: typeof EncodedVideoChunk;
  now: () => number; // wall clock, ms (Date.now)
  raf: (fn: () => void) => number;
  cancelRaf: (id: number) => void;
}

function browserEnv(): VideoEnv {
  return {
    WebSocket: globalThis.WebSocket,
    VideoDecoder: globalThis.VideoDecoder,
    EncodedVideoChunk: globalThis.EncodedVideoChunk,
    now: () => Date.now(),
    raf: (fn) => requestAnimationFrame(fn),
    cancelRaf: (id) => cancelAnimationFrame(id),
  };
}

// A due time this far ahead is a bad offset, not a real delay: show now.
const MAX_AHEAD_MS = 2000;
// Experimental (Settings → Voice, "Smoother screen shares"): a screen
// share's frame is shown at its capture time plus the smallest delay seen
// lately plus this margin, so frames are paced by when they were
// captured, not by when they happened to arrive (a frame just missing a
// vsync waited for the next one). Off by default.
const SCREEN_JITTER_MS = 20;
const SCREEN_LAG_WINDOW = 90; // frames (3 s at 30 fps)

interface Pending {
  frame: VideoFrame;
  captureUS: number;
  arrivedMs: number;
}

/** One received track: its decoder and the frames waiting for their time. */
class TrackPlayer {
  dec: VideoDecoder | null = null;
  private descKey = '';
  private waitingForKey = true;
  queue: Pending[] = [];
  canvas: HTMLCanvasElement | null = null;
  // A screen share, and whether it's paced by its own jitter buffer.
  screen = false;
  pace = false;
  private lags: number[] = [];
  stats: TrackStats = { decoded: 0, shown: 0, dropped: 0, lastSkewMs: null, synced: false };

  constructor(
    private env: VideoEnv,
    readonly trackId: number,
    private askKeyframe: (trackId: number) => void,
  ) {}

  push(m: FrameMsg): void {
    if (m.desc) {
      const key = Array.from(m.desc).join(',');
      if (!this.dec || this.dec.state === 'closed' || key !== this.descKey) this.configure(m.desc, key);
    }
    if (!this.dec || this.dec.state !== 'configured') {
      this.askKeyframe(this.trackId);
      return;
    }
    if (this.waitingForKey) {
      if (!m.keyframe) return;
      this.waitingForKey = false;
    }
    try {
      this.dec.decode(new this.env.EncodedVideoChunk({
        type: m.keyframe ? 'key' : 'delta', timestamp: m.captureUS, data: m.data,
      }));
    } catch {
      this.reset();
    }
  }

  private configure(desc: Uint8Array, key: string): void {
    this.closeDecoder();
    const dec = new this.env.VideoDecoder({
      output: (frame) => {
        this.stats.decoded++;
        const arrivedMs = this.env.now();
        if (this.screen && this.pace) {
          this.lags.push(arrivedMs - frame.timestamp / 1000);
          if (this.lags.length > SCREEN_LAG_WINDOW) this.lags.shift();
        }
        this.queue.push({ frame, captureUS: frame.timestamp, arrivedMs });
      },
      error: () => this.reset(),
    });
    dec.configure({ codec: codecFromDesc(desc), description: desc, optimizeForLatency: true });
    this.dec = dec;
    this.descKey = key;
    this.waitingForKey = true;
  }

  // A decoder error: start again from the next keyframe.
  private reset(): void {
    this.closeDecoder();
    this.descKey = '';
    this.waitingForKey = true;
    this.askKeyframe(this.trackId);
  }

  private closeDecoder(): void {
    if (this.dec && this.dec.state !== 'closed') {
      try {
        this.dec.close();
      } catch {
        // already closed
      }
    }
    this.dec = null;
  }

  /** Shows the newest frame that is due (dropping older ones). */
  render(nowMs: number, offsetUS: number | undefined): void {
    const paced = this.screen && this.pace;
    if (paced) offsetUS = undefined; // paced by its own buffer, not the audio
    this.stats.synced = offsetUS !== undefined;
    const lagMs = paced && this.lags.length > 0 ? Math.min(...this.lags) + SCREEN_JITTER_MS : null;
    const due = (p: Pending) => {
      if (lagMs !== null) return Math.min(p.captureUS / 1000 + lagMs, p.arrivedMs + 100);
      if (offsetUS === undefined) return p.arrivedMs;
      const d = (p.captureUS + offsetUS) / 1000;
      return d - nowMs > MAX_AHEAD_MS ? p.arrivedMs : d;
    };
    let pick = -1;
    for (let i = 0; i < this.queue.length; i++) {
      if (due(this.queue[i]) <= nowMs) pick = i;
    }
    if (pick < 0) return;
    for (let i = 0; i < pick; i++) {
      this.queue[i].frame.close();
      this.stats.dropped++;
    }
    const p = this.queue[pick];
    this.queue = this.queue.slice(pick + 1);
    if (offsetUS !== undefined) this.stats.lastSkewMs = nowMs - (p.captureUS + offsetUS) / 1000;
    this.draw(p.frame);
    this.stats.shown++;
    p.frame.close();
  }

  private draw(f: VideoFrame): void {
    const c = this.canvas;
    if (!c) return;
    const ctx = c.getContext('2d');
    if (!ctx) return;
    const dpr = globalThis.devicePixelRatio || 1;
    const w = Math.max(1, Math.round(c.clientWidth * dpr));
    const h = Math.max(1, Math.round(c.clientHeight * dpr));
    if (c.width !== w || c.height !== h) {
      c.width = w;
      c.height = h;
    }
    // data-fit on the canvas: cameras cover their tile, screens are
    // letterboxed (CallView).
    const r = fitRect(f.displayWidth, f.displayHeight, w, h, c.dataset.fit === 'cover' ? 'cover' : 'contain');
    ctx.clearRect(0, 0, w, h);
    ctx.drawImage(f, r.x, r.y, r.w, r.h);
  }

  close(): void {
    for (const p of this.queue) p.frame.close();
    this.queue = [];
    this.closeDecoder();
  }
}

export interface TileSize {
  trackId: number;
  width: number; // device pixels
  height: number;
  visible: boolean;
}

export class VideoController {
  private snapshot: VideoSnapshot = { state: EMPTY_VIDEO_STATE, open: false, pinned: 0 };
  private listeners = new Set<(s: VideoSnapshot) => void>();
  private env: VideoEnv;
  private off: (() => void) | null = null;
  private ws: WebSocket | null = null;
  private wsUrl = '';
  private players = new Map<number, TrackPlayer>();
  private offsets = new Map<number, number>();
  private subs = new Map<number, number>(); // track → layer asked for
  private rafId = 0;
  private previewCanvas: HTMLCanvasElement | null = null;
  private previewSrc: HTMLCanvasElement | null = null;
  private disposed = false;

  constructor(private bridge: VideoBridge, env?: Partial<VideoEnv>) {
    this.env = { ...browserEnv(), ...env };
    let pushed = false;
    this.off = bridge.onState((s) => { pushed = true; this.setState(s); });
    // The first answer, unless a newer state was pushed meanwhile.
    void bridge.state().then((s) => { if (!pushed) this.setState(s); }, () => {});
    // Back in front (the webview shown again): turn a camera the system
    // stopped in the background back on. Go also hears the OS's own
    // "active again" (iOS, Android, a Mac's wake); both are no-ops when
    // there's nothing to resume.
    if (typeof document !== 'undefined' && bridge.resumeCamera) {
      const shown = (): void => {
        if (document.visibilityState === 'visible' && this.snapshot.state.camera.paused) {
          void bridge.resumeCamera?.().then((s) => this.setState(s), () => {});
        }
      };
      document.addEventListener('visibilitychange', shown);
      this.offVisible = () => document.removeEventListener('visibilitychange', shown);
    }
  }

  private offVisible?: () => void;

  getSnapshot(): VideoSnapshot {
    return this.snapshot;
  }

  subscribe(fn: (s: VideoSnapshot) => void): () => void {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  }

  private publish(next: Partial<VideoSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...next };
    for (const fn of this.listeners) fn(this.snapshot);
  }

  private setState(s: VideoState): void {
    if (this.disposed) return;
    const live = new Set(s.tracks.map((t) => t.trackId));
    for (const [id, p] of this.players) {
      if (!live.has(id)) {
        p.close();
        this.players.delete(id);
        this.subs.delete(id);
      }
    }
    let { pinned } = this.snapshot;
    if (pinned && !live.has(pinned)) pinned = 0;
    this.publish({ state: s, pinned });
    this.syncSocket();
    // Joined with the camera chosen on the pre-join view: on once the
    // call's video is up.
    if (this.cameraOnJoin && s.available && s.status === 'connected' && s.canCapture && s.canPublish) {
      this.cameraOnJoin = false;
      if (!s.camera.on && !s.camera.starting) void this.setCamera(true, this.cameraOnJoinId);
    }
  }

  private cameraOnJoin = false;
  private cameraOnJoinId = '';

  /** The pre-join choice: turn the camera on as soon as the call's video
   * is up (or not). Cleared once used, and by leaving. */
  setCameraOnJoin(on: boolean, cameraId = ''): void {
    this.cameraOnJoin = on;
    this.cameraOnJoinId = cameraId;
  }

  /** The pre-join camera preview: the camera for your eyes only, drawn in
   * the canvas given to attachPreview; nothing is sent. */
  previewCamera(on: boolean, cameraId = ''): Promise<VideoState | null> {
    if (!this.bridge.previewCamera) return Promise.resolve(null);
    return this.bridge.previewCamera(on, cameraId).then((s) => { this.setState(s); return s; }, () => null);
  }

  /** The call view opened or closed: video is only received while open. */
  setOpen(open: boolean): void {
    if (open === this.snapshot.open) return;
    this.publish({ open });
    if (!open) {
      for (const id of [...this.subs.keys()]) void this.bridge.unsubscribe(id);
      this.subs.clear();
    }
    this.syncSocket();
  }

  pin(trackId: number): void {
    this.publish({ pinned: this.snapshot.pinned === trackId ? 0 : trackId });
  }

  /** The big tile: the pinned track, else the newest screen share. */
  bigTile(): number {
    const { pinned, state } = this.snapshot;
    if (pinned) return pinned;
    const screens = state.tracks.filter((t) => t.kind === 'screen');
    return screens.length ? screens[screens.length - 1].trackId : 0;
  }

  setCamera(on: boolean, cameraId = ''): Promise<VideoState> {
    return this.bridge.setCamera(on, cameraId).then((s) => { this.setState(s); return s; });
  }

  /** Share a screen or window optimized for detail or motion, with its
   * sound or not (the picker). */
  shareScreen(sourceId: string, mode: 'detail' | 'motion', sound = false): Promise<VideoState> {
    const p = this.bridge.shareScreen ? this.bridge.shareScreen(true, sourceId, mode, sound) : this.bridge.setScreen(true, sourceId);
    return p.then((s) => { this.setState(s); return s; });
  }

  /** How loud a screen share's sound is for us: percent, 0 = muted. */
  setShareVolume(trackId: number, percent: number): Promise<VideoState | null> {
    if (!this.bridge.setShareVolume) return Promise.resolve(null);
    return this.bridge.setShareVolume(trackId, percent).then((s) => { this.setState(s); return s; });
  }

  /** Share another source on the same track ("Switch to this"). */
  switchScreen(sourceId: string): Promise<VideoState | null> {
    if (!this.bridge.switchScreen) return Promise.resolve(null);
    return this.bridge.switchScreen(sourceId).then((s) => { this.setState(s); return s; });
  }

  /** The picker's live thumbnails (data: URLs); keeps them coming. */
  screenThumbnails(ids: string[]): Promise<Record<string, string>> {
    return this.bridge.screenThumbnails ? this.bridge.screenThumbnails(ids).catch(() => ({})) : Promise.resolve({});
  }

  /** The picker closed: stop the thumbnail capture. */
  stopThumbnails(): void {
    void this.bridge.stopThumbnails?.().catch(() => {});
  }

  setScreen(on: boolean, sourceId = ''): Promise<VideoState> {
    return this.bridge.setScreen(on, sourceId).then((s) => { this.setState(s); return s; });
  }

  cameras(): Promise<VideoCamera[]> {
    return this.bridge.cameras();
  }

  screenSources(): Promise<VideoSource[]> {
    return this.bridge.screenSources();
  }

  /** The call view reports its tiles after layout: each visible track is
   * received at the layer that fits; the rest not at all. */
  tiles(sizes: TileSize[]): void {
    if (!this.snapshot.open) return;
    const tracks = new Map<number, VideoTrack>(this.snapshot.state.tracks.map((t) => [t.trackId, t]));
    const want = new Map<number, number>();
    for (const s of sizes) {
      const t = tracks.get(s.trackId);
      if (!t || t.self) continue;
      // A screen share takes its top layer whatever the tile's size: its
      // small layer runs at half the rate (15 against 30 fps), and a
      // phone's tile is small. The server's bandwidth controller still
      // steps it down when the link can't take it. Cameras: by size.
      const layer = t.kind === 'screen' && s.visible && t.layers.length > 0
        ? t.layers.reduce((a, b) => (b.width * b.height > a.width * a.height ? b : a)).id
        : layerForTile(t.layers, s.width, s.height, s.visible);
      if (layer !== null) want.set(s.trackId, layer);
    }
    for (const [id, layer] of want) {
      if (this.subs.get(id) !== layer) {
        this.subs.set(id, layer);
        void this.bridge.subscribe(id, layer);
      }
    }
    for (const id of [...this.subs.keys()]) {
      if (!want.has(id)) {
        this.subs.delete(id);
        void this.bridge.unsubscribe(id);
      }
    }
  }

  /** Where a track's frames are drawn (null: not shown). */
  attachCanvas(trackId: number, canvas: HTMLCanvasElement | null): void {
    const p = this.player(trackId);
    p.canvas = canvas;
  }

  /** Where our camera's self-view is drawn. */
  attachPreview(canvas: HTMLCanvasElement | null): void {
    this.previewCanvas = canvas;
  }

  stats(): Record<number, TrackStats> {
    const out: Record<number, TrackStats> = {};
    for (const [id, p] of this.players) out[id] = { ...p.stats };
    return out;
  }

  private player(trackId: number): TrackPlayer {
    let p = this.players.get(trackId);
    if (!p) {
      p = new TrackPlayer(this.env, trackId, (id) => this.askKeyframe(id));
      p.screen = this.snapshot.state.tracks.find((t) => t.trackId === trackId)?.kind === 'screen';
      p.pace = getVoiceSettings().screenPacing;
      this.players.set(trackId, p);
    }
    return p;
  }

  private lastAsk = new Map<number, number>();

  private askKeyframe(trackId: number): void {
    const now = this.env.now();
    if (now - (this.lastAsk.get(trackId) ?? 0) < 500) return;
    this.lastAsk.set(trackId, now);
    if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify({ type: 'keyframe', trackId }));
  }

  // The frame socket is open while the call view is and video is up.
  private syncSocket(): void {
    // Open while the call view is (video is up), or while the pre-join
    // preview runs (its self-view comes over the same socket).
    const st = this.snapshot.state;
    const previewing = !!(st.preview?.on || st.preview?.starting);
    const url = (this.snapshot.open && st.available) || previewing ? st.frameUrl ?? '' : '';
    if (url === this.wsUrl) return;
    this.closeSocket();
    this.wsUrl = url;
    if (!url) return;
    const ws = new this.env.WebSocket(url);
    ws.binaryType = 'arraybuffer';
    ws.onmessage = (ev: MessageEvent) => {
      try {
        this.onSocketMessage(ev);
      } catch (e) {
        this.reportError('frame socket', e);
      }
    };
    ws.onclose = () => {
      if (this.ws === ws) {
        this.ws = null;
        this.wsUrl = '';
      }
    };
    this.ws = ws;
    this.startRender();
  }

  private closeSocket(): void {
    if (this.ws) {
      const ws = this.ws;
      this.ws = null;
      ws.onclose = null;
      ws.close();
    }
    this.wsUrl = '';
    if (this.rafId) this.env.cancelRaf(this.rafId);
    this.rafId = 0;
  }

  private startRender(): void {
    const tick = () => {
      if (!this.ws) {
        this.rafId = 0;
        return;
      }
      // An exception here must not end the loop: every tile would freeze.
      try {
        this.renderFrame();
      } catch (e) {
        this.reportError('render', e);
      }
      this.rafId = this.env.raf(tick);
    };
    this.rafId = this.env.raf(tick);
  }

  private onSocketMessage(ev: MessageEvent): void {
    if (typeof ev.data === 'string') {
      const m = parseText(ev.data);
      if (m) this.offsets = m.offsets;
      return;
    }
    const m = parseBinary(ev.data as ArrayBuffer);
    if (!m) return;
    if (m.kind === 'frame') this.player(m.trackId).push(m);
    else this.drawPreview(m.width, m.height, m.rgba);
  }

  private reported = 0;

  // Errors in the video path go to the console and (the first few) to Go's
  // log over the frame socket: a phone's webview console isn't at hand.
  private reportError(where: string, e: unknown): void {
    const msg = e instanceof Error ? `${e.name}: ${e.message}${e.stack ? `\n${e.stack.split('\n').slice(0, 4).join('\n')}` : ''}` : String(e);
    console.error(`[video] ${where}:`, e);
    if (this.reported >= 20) return;
    this.reported++;
    try {
      if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify({ type: 'log', where, msg }));
    } catch {
      // the socket is going away
    }
  }

  /** One render pass (the animation frame; tests call it directly). */
  renderFrame(): void {
    const now = this.env.now();
    for (const [id, p] of this.players) p.render(now, this.offsets.get(id));
  }

  private drawPreview(w: number, h: number, rgba: Uint8ClampedArray): void {
    const c = this.previewCanvas;
    if (!c) return;
    const ctx = c.getContext('2d');
    if (!ctx) return;
    // The picture goes to a scratch canvas at its own size, then into the
    // tile like a received camera (cover, within limits): stretching the
    // canvas instead squashed it into a phone's tall tiles.
    const src = (this.previewSrc ??= document.createElement('canvas'));
    if (src.width !== w || src.height !== h) {
      src.width = w;
      src.height = h;
    }
    src.getContext('2d')?.putImageData(new ImageData(new Uint8ClampedArray(rgba), w, h), 0, 0);
    const dpr = globalThis.devicePixelRatio || 1;
    const cw = Math.max(1, Math.round(c.clientWidth * dpr));
    const ch = Math.max(1, Math.round(c.clientHeight * dpr));
    if (c.width !== cw || c.height !== ch) {
      c.width = cw;
      c.height = ch;
    }
    const r = fitRect(w, h, cw, ch, 'cover');
    ctx.clearRect(0, 0, cw, ch);
    ctx.drawImage(src, r.x, r.y, r.w, r.h);
  }

  dispose(): void {
    this.disposed = true;
    this.off?.();
    this.offVisible?.();
    this.closeSocket();
    for (const p of this.players.values()) p.close();
    this.players.clear();
    this.listeners.clear();
  }
}

let instance: VideoController | null = null;

export function getVideoController(): VideoController | null {
  return instance;
}

export function setVideoController(c: VideoController | null): void {
  instance?.dispose();
  instance = c;
}
