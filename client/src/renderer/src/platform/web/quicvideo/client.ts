// Copied from boson-chat/quicvideo@v1.14.0 (80ae103) web/src (client.ts). Keep in sync; local changes are marked "boson:".
// quicvideo browser client: the same protocol as the Go SDK, over
// WebTransport, with WebCodecs for encode/decode.
import { create, type MessageInitShape } from "@bufbuild/protobuf";
import {
  type ControlMessage,
  ControlMessageSchema,
  type Layer,
  LayerSchema,
  type RoomState,
  type SubscriptionState,
  type Track,
  TrackKind,
} from "./gen/quicvideo/v1/control_pb";
import { avcCodec, type LayerSpec } from "./layers";
import { ByteReader, encodeControl, frameHeader, groupHeader, readControl, readFrame } from "./wire";

/** boson: one received frame, undecoded (Annex B). */
export interface RawFrame {
  trackId: number;
  layer: number;
  group: bigint;
  first: boolean;
  keyframe: boolean;
  captureUS: bigint;
  payload: Uint8Array;
}

export interface ConnectOptions {
  /** SHA-256 (hex) of a self-signed dev certificate (/v1/info). */
  certHash?: string;
}

type Events = {
  track: (t: Track) => void;
  trackRemoved: (id: number) => void;
  participant: (id: number, name: string, joined: boolean) => void;
  state: (s: SubscriptionState) => void;
  error: (msg: string) => void;
  closed: (reason: string) => void;
  // boson: every control message (the app keeps its own room state).
  control: (m: ControlMessage) => void;
};

const hexToBytes = (hex: string) => Uint8Array.from(hex.match(/../g)!.map((b) => parseInt(b, 16)));
const nowUS = () => BigInt(Math.round((performance.timeOrigin + performance.now()) * 1000));

export class QuicVideoClient {
  readonly wt: WebTransport;
  sessionId = 0;
  private ctrl!: WritableStreamDefaultWriter<Uint8Array>;
  private waiters: ((m: ControlMessage) => boolean)[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private listeners = new Map<keyof Events, ((...a: any[]) => void)[]>();
  private publications = new Map<number, Publication>();
  private decoders = new Map<number, RemoteTrack>();
  // boson: tracks received as raw (Annex-B) frames for the app's own
  // decoder (platform/web/video), instead of decoded here.
  private raw = new Set<number>();
  onRawFrame: ((f: RawFrame) => void) | null = null;
  private nextRef = 1;

  private constructor(wt: WebTransport) {
    this.wt = wt;
  }

  /** Connects to https://host:port/wt and authenticates. */
  static async connect(url: string, token: string, opts: ConnectOptions = {}): Promise<QuicVideoClient> {
    const wtOpts: WebTransportOptions = {};
    if (opts.certHash) wtOpts.serverCertificateHashes = [{ algorithm: "sha-256", value: hexToBytes(opts.certHash) }];
    const wt = new WebTransport(url, wtOpts);
    await wt.ready;
    const c = new QuicVideoClient(wt);
    const bidi = await wt.createBidirectionalStream();
    c.ctrl = bidi.writable.getWriter();
    const welcome = c.waitFor((m) => m.msg.case === "welcome" || m.msg.case === "error");
    void c.readControlLoop(new ByteReader(bidi.readable));
    void c.acceptMediaLoop();
    wt.closed.then(
      (i) => c.emit("closed", i.reason || "closed"),
      (e) => c.emit("closed", String(e)),
    );
    await c.send({ case: "hello", value: { token, clientVersion: "web/dev" } });
    const m = await welcome;
    if (m.msg.case === "error") throw new Error(m.msg.value.message);
    if (m.msg.case === "welcome") c.sessionId = m.msg.value.sessionId;
    return c;
  }

  on<K extends keyof Events>(ev: K, fn: Events[K]): void {
    this.listeners.set(ev, [...(this.listeners.get(ev) ?? []), fn]);
  }
  private emit<K extends keyof Events>(ev: K, ...args: Parameters<Events[K]>): void {
    for (const fn of this.listeners.get(ev) ?? []) fn(...args);
  }

  async send(msg: MessageInitShape<typeof ControlMessageSchema>["msg"]): Promise<void> {
    await this.ctrl.write(encodeControl(create(ControlMessageSchema, { msg })));
  }

  private waitFor(pred: (m: ControlMessage) => boolean, ms = 10_000): Promise<ControlMessage> {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("timed out waiting for the server")), ms);
      this.waiters.push((m) => {
        if (!pred(m)) return false;
        clearTimeout(t);
        resolve(m);
        return true;
      });
    });
  }

  private async readControlLoop(r: ByteReader): Promise<void> {
    try {
      for (;;) {
        const m = await readControl(r);
        if (!m) return;
        const i = this.waiters.findIndex((w) => w(m));
        if (i >= 0) {
          this.waiters.splice(i, 1);
          continue;
        }
        this.dispatch(m);
      }
    } catch (e) {
      this.emit("closed", String(e));
    }
  }

  private dispatch(m: ControlMessage): void {
    this.emit("control", m); // boson
    switch (m.msg.case) {
      case "trackAdded":
        if (m.msg.value.track) this.emit("track", m.msg.value.track);
        break;
      case "trackRemoved":
        this.raw.delete(m.msg.value.trackId);
        this.decoders.get(m.msg.value.trackId)?.close();
        this.decoders.delete(m.msg.value.trackId);
        this.emit("trackRemoved", m.msg.value.trackId);
        break;
      case "participantJoined":
        this.emit("participant", m.msg.value.participant!.sessionId, m.msg.value.participant!.displayName, true);
        break;
      case "participantLeft":
        this.emit("participant", m.msg.value.sessionId, "", false);
        break;
      case "subscriptionState":
        this.emit("state", m.msg.value);
        break;
      case "layerActive":
        this.publications.get(m.msg.value.trackId)?.setActive(m.msg.value.layer, m.msg.value.active);
        break;
      case "keyframeRequest":
        this.publications.get(m.msg.value.trackId)?.requestKeyframe(m.msg.value.layer);
        break;
      case "error":
        this.emit("error", m.msg.value.message);
        break;
    }
  }

  async join(room: string): Promise<RoomState> {
    const reply = this.waitFor((m) => m.msg.case === "roomState" || m.msg.case === "error");
    await this.send({ case: "join", value: { room } });
    const m = await reply;
    if (m.msg.case === "error") throw new Error(m.msg.value.message);
    return (m.msg as { case: "roomState"; value: RoomState }).value;
  }

  /** Subscribes to a track (maxLayer: best layer wanted) and decodes it. */
  async subscribe(track: Track, maxLayer: number, onFrame: (f: VideoFrame) => void): Promise<void> {
    if (!this.decoders.has(track.trackId)) this.decoders.set(track.trackId, new RemoteTrack(onFrame));
    await this.send({ case: "subscribe", value: { trackId: track.trackId, layer: maxLayer, priority: 0 } });
  }

  /** boson: subscribes to a track and hands its frames to onRawFrame undecoded. */
  async subscribeRaw(trackId: number, maxLayer: number): Promise<void> {
    this.raw.add(trackId);
    await this.send({ case: "subscribe", value: { trackId, layer: maxLayer, priority: 0 } });
  }

  async unsubscribe(trackId: number): Promise<void> {
    this.raw.delete(trackId);
    this.decoders.get(trackId)?.close();
    this.decoders.delete(trackId);
    await this.send({ case: "unsubscribe", value: { trackId } });
  }

  /** Decoded frame counts per track (diagnostics/tests). */
  stats(): Record<number, number> {
    const out: Record<number, number> = {};
    for (const [id, t] of this.decoders) out[id] = t.decoded;
    return out;
  }

  private async acceptMediaLoop(): Promise<void> {
    const reader = this.wt.incomingUnidirectionalStreams.getReader();
    for (;;) {
      const { value, done } = await reader.read().catch(() => ({ value: undefined, done: true }));
      if (done || !value) return;
      void this.readGroup(new ByteReader(value));
    }
  }

  private async readGroup(r: ByteReader): Promise<void> {
    try {
      const track = await r.varint();
      const layer = await r.varint();
      const group = await r.varint();
      if (track === null || layer === null || group === null) return;
      if (this.raw.has(Number(track))) {
        // boson: raw frames for the app's decoder.
        for (let first = true; ; first = false) {
          const f = await readFrame(r);
          if (!f) return;
          this.onRawFrame?.({ trackId: Number(track), layer: Number(layer), group, first, keyframe: f.keyframe, captureUS: f.captureUS, payload: f.payload });
        }
      }
      const dec = this.decoders.get(Number(track));
      if (!dec) return r.cancel();
      for (let first = true; ; first = false) {
        const f = await readFrame(r);
        if (!f) return;
        dec.frame(Number(layer), group, first, f.keyframe, f.captureUS, f.payload);
      }
    } catch {
      // reset by the server (dropped/superseded group): wait for the next one
    }
  }

  /** Publishes a camera or screen MediaStreamTrack with simulcast layers. */
  async publish(kind: TrackKind, media: MediaStreamTrack, layers: LayerSpec[]): Promise<Publication> {
    const ref = String(this.nextRef++);
    const reply = this.waitFor(
      (m) => (m.msg.case === "publishOk" && m.msg.value.clientRef === ref) || (m.msg.case === "error" && m.msg.value.clientRef === ref),
    );
    await this.send({
      case: "publish",
      value: { clientRef: ref, kind, codec: "h264", layers: layers.map((l) => create(LayerSchema, { ...l, bitrate: BigInt(l.bitrate) })) },
    });
    const m = await reply;
    if (m.msg.case === "error") throw new Error(m.msg.value.message);
    const id = (m.msg as { case: "publishOk"; value: { trackId: number } }).value.trackId;
    const p = new Publication(this, id, kind, media, layers);
    this.publications.set(id, p);
    return p;
  }

  unpublished(id: number): void {
    this.publications.delete(id);
  }

  close(): void {
    for (const p of this.publications.values()) p.stop();
    for (const d of this.decoders.values()) d.close();
    this.wt.close();
  }
}

/** Decodes one remote track: only the newest group is fed to the decoder. */
class RemoteTrack {
  private dec: VideoDecoder;
  private layer = -1;
  private group = -1n;
  private synced = false;
  decoded = 0;
  constructor(private onFrame: (f: VideoFrame) => void) {
    this.dec = this.newDecoder();
  }
  private newDecoder(): VideoDecoder {
    const d = new VideoDecoder({
      output: (f) => {
        this.decoded++;
        this.onFrame(f);
      },
      error: () => {
        this.synced = false;
      },
    });
    // Annex-B input (no description): SPS/PPS come in-band on keyframes;
    // a layer switch changes the size and the decoder follows.
    d.configure({ codec: "avc1.64002a", optimizeForLatency: true });
    return d;
  }
  frame(layer: number, group: bigint, first: boolean, key: boolean, us: bigint, data: Uint8Array): void {
    if (first) {
      if (this.synced && layer === this.layer && group <= this.group) return; // an older group finishing late
      if (!key) return;
      this.layer = layer;
      this.group = group;
      this.synced = true;
    } else if (!this.synced || layer !== this.layer || group !== this.group) {
      return;
    }
    if (this.dec.state === "closed") {
      this.dec = this.newDecoder();
      if (!key) return;
    }
    try {
      this.dec.decode(new EncodedVideoChunk({ type: key ? "key" : "delta", timestamp: Number(us), data }));
    } catch {
      this.synced = false;
    }
  }
  close(): void {
    if (this.dec.state !== "closed") this.dec.close();
  }
}

/** boson: a hidden, in-document home for capture <video> elements. WebKit
 * (Safari) doesn't advance the frames of a <video> that isn't in the
 * document, so a detached one gives no pictures. */
export function mediaHost(): HTMLElement {
  const id = "boson-media-host";
  let el = document.getElementById(id);
  if (!el) {
    el = document.createElement("div");
    el.id = id;
    el.setAttribute("aria-hidden", "true");
    el.style.cssText = "position:fixed;left:0;top:0;width:2px;height:2px;overflow:hidden;opacity:0.01;pointer-events:none;z-index:-1";
    document.body.appendChild(el);
  }
  return el;
}

/** boson: a muted, inline <video> playing a stream, in the document. */
export function captureVideo(stream: MediaStream): HTMLVideoElement {
  const video = document.createElement("video");
  video.muted = true;
  video.defaultMuted = true;
  video.playsInline = true;
  video.autoplay = true;
  video.setAttribute("muted", "");
  video.setAttribute("playsinline", "");
  video.width = 2;
  video.height = 2;
  video.srcObject = stream;
  mediaHost().appendChild(video);
  return video;
}

/** boson: a capture <video> done with. */
export function releaseVideo(video: HTMLVideoElement): void {
  video.pause();
  video.srcObject = null;
  video.remove();
}

/** A published track: one VideoEncoder per active layer. */
export class Publication {
  private encoders = new Map<number, LayerEncoder>();
  private running = true;
  private lastFrameAt = 0;
  // boson: frames captured and sent, and why sending failed (shown on the tile).
  captured = 0;
  failure = "";
  onFailure: ((reason: string) => void) | null = null;
  private video: HTMLVideoElement | null = null;
  constructor(
    private c: QuicVideoClient,
    readonly trackId: number,
    readonly kind: TrackKind,
    private media: MediaStreamTrack,
    readonly layers: LayerSpec[],
  ) {
    this.pump().catch((e) => this.fail(`the camera gave no pictures (${e instanceof Error ? e.message : String(e)})`));
  }

  /** boson: frames encoded and sent, over all layers. */
  sent(): number {
    let n = 0;
    for (const e of this.encoders.values()) n += e.sent;
    return n;
  }

  /** boson: a send failure, once. */
  fail(reason: string): void {
    if (this.failure || !this.running) return;
    this.failure = reason;
    this.onFailure?.(reason);
  }

  /** boson: ms since the last captured frame (a stalled capture). */
  idleMs(): number {
    return this.lastFrameAt ? performance.now() - this.lastFrameAt : 0;
  }

  activeLayers(): number[] {
    return [...this.encoders.keys()];
  }

  setActive(layer: number, active: boolean): void {
    const spec = this.layers.find((l) => l.id === layer);
    if (!spec) return;
    if (active && !this.encoders.has(layer)) {
      // boson: a config the encoder refuses (here or later) is reported, not
      // thrown into the control loop (that ended the whole session).
      try {
        this.encoders.set(layer, new LayerEncoder(this.c, this.trackId, spec, this.kind === TrackKind.SCREEN, (r) => this.fail(r)));
      } catch (e) {
        this.fail(`the video encoder refused ${spec.width}×${spec.height}: ${e instanceof Error ? e.message : String(e)}`);
      }
    } else if (!active) {
      this.encoders.get(layer)?.close();
      this.encoders.delete(layer);
    }
  }

  requestKeyframe(layer: number): void {
    this.encoders.get(layer)?.forceKey();
  }

  // Captured frames: MediaStreamTrackProcessor where available (Chromium),
  // else a <video> drawn at the top layer's frame rate.
  private async pump(): Promise<void> {
    const top = Math.max(...this.layers.map((l) => l.fps));
    if ("MediaStreamTrackProcessor" in globalThis) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const proc = new (globalThis as any).MediaStreamTrackProcessor({ track: this.media });
      const reader: ReadableStreamDefaultReader<VideoFrame> = proc.readable.getReader();
      while (this.running) {
        const { value, done } = await reader.read();
        if (done || !value) break;
        this.feed(value, top);
        value.close();
      }
      return;
    }
    // boson: Safari (no MediaStreamTrackProcessor outside workers): a
    // <video> in the document (a detached one gives WebKit no frames),
    // read on each new picture where requestVideoFrameCallback exists.
    const video = captureVideo(new MediaStream([this.media]));
    this.video = video;
    await video.play();
    const rvfc = typeof (video as HTMLVideoElement & { requestVideoFrameCallback?: unknown }).requestVideoFrameCallback === "function";
    while (this.running) {
      if (rvfc) {
        await Promise.race([
          new Promise<void>((r) => video.requestVideoFrameCallback(() => r())),
          new Promise<void>((r) => setTimeout(r, 250)),
        ]);
      } else {
        await new Promise((r) => setTimeout(r, 1000 / top));
      }
      if (!this.running) break;
      if (video.videoWidth === 0 || video.readyState < 2) continue;
      const f = new VideoFrame(video, { timestamp: Number(nowUS()) });
      this.feed(f, top);
      f.close();
    }
  }

  private feed(f: VideoFrame, _top: number): void {
    this.lastFrameAt = performance.now();
    this.captured++;
    const us = nowUS();
    for (const e of this.encoders.values()) e.encode(f, us);
  }

  stop(): void {
    this.running = false;
    if (this.video) releaseVideo(this.video);
    this.video = null;
    for (const e of this.encoders.values()) e.close();
    this.encoders.clear();
    this.media.stop();
    void this.c.send({ case: "unpublish", value: { trackId: this.trackId } }).catch(() => {});
    this.c.unpublished(this.trackId);
  }
}

class LayerEncoder {
  private enc: VideoEncoder;
  private canvas: OffscreenCanvas;
  private ctx: OffscreenCanvasRenderingContext2D;
  private stream: WritableStreamDefaultWriter<Uint8Array> | null = null;
  private group = 0n;
  private force = true;
  private dropping = false;
  private lastUS = 0n;
  private captureOf = new Map<number, bigint>();

  sent = 0; // boson: frames written to the server

  constructor(private c: QuicVideoClient, private trackId: number, private spec: LayerSpec, screen: boolean,
    private onFail: (reason: string) => void = () => {}) {
    this.canvas = new OffscreenCanvas(spec.width, spec.height);
    this.ctx = this.canvas.getContext("2d")!;
    const base = {
      codec: avcCodec(spec.width, spec.height, spec.fps),
      width: spec.width,
      height: spec.height,
      bitrate: spec.bitrate,
      framerate: spec.fps,
      avc: { format: "annexb" },
    };
    const hint = { contentHint: screen ? "text" : "motion" };
    // Fallbacks: Firefox (macOS) reports latencyMode "realtime" as supported
    // in isConfigSupported, then fails configure() with EncodingError and
    // closes the encoder.
    this.configs = [
      { ...base, ...hint, latencyMode: "realtime" },
      { ...base, ...hint },
      { ...base },
    ] as VideoEncoderConfig[];
    this.enc = this.newEncoder();
  }

  private configs: VideoEncoderConfig[];
  private configIdx = 0;

  /** An encoder on the current config; an error moves to the next config
   * (or, once a config worked, retries it: e.g. a GPU reset). */
  private newEncoder(): VideoEncoder {
    const enc = new VideoEncoder({
      output: (chunk) => {
        this.produced = true;
        void this.output(chunk);
      },
      error: (e) => {
        if (enc !== this.enc || this.closed) return;
        if (!this.produced) {
          // This config never worked: try the next, or give up (no encoder).
          if (this.configIdx === this.configs.length - 1) {
            this.onFail(`the video encoder failed (${e?.message || "H.264 at " + this.spec.width + "×" + this.spec.height})`); // boson
            return;
          }
          this.configIdx++;
        }
        this.force = true;
        this.enc = this.newEncoder();
      },
    });
    // boson: configure() throws on a config it can't take (e.g. a codec
    // string or size the platform's encoder refuses): the next config.
    try {
      enc.configure(this.configs[this.configIdx]);
    } catch (e) {
      if (this.configIdx === this.configs.length - 1) throw e;
      try { enc.close(); } catch { /* not configured */ }
      this.configIdx++;
      return this.newEncoder();
    }
    return enc;
  }

  private produced = false;
  private closed = false;

  forceKey(): void {
    this.force = true;
  }

  encode(f: VideoFrame, us: bigint): void {
    const interval = BigInt(Math.floor(1_000_000 / this.spec.fps));
    if (!this.force && this.lastUS && us < this.lastUS + (interval * 85n) / 100n) return; // fps cap
    if (this.enc.state !== "configured") return; // being replaced after an error
    if (this.enc.encodeQueueSize > 2) return; // encoder behind: skip
    this.lastUS = us;
    // Scale to the layer (letterboxed onto the layer's canvas).
    const s = Math.min(this.spec.width / f.displayWidth, this.spec.height / f.displayHeight);
    const w = f.displayWidth * s;
    const h = f.displayHeight * s;
    this.ctx.fillStyle = "#000";
    this.ctx.fillRect(0, 0, this.spec.width, this.spec.height);
    this.ctx.drawImage(f, (this.spec.width - w) / 2, (this.spec.height - h) / 2, w, h);
    const ts = Number(us);
    const scaled = new VideoFrame(this.canvas, { timestamp: ts });
    this.captureOf.set(ts, us);
    const key = this.force;
    this.force = false;
    this.enc.encode(scaled, { keyFrame: key });
    scaled.close();
  }

  private async output(chunk: EncodedVideoChunk): Promise<void> {
    const data = new Uint8Array(chunk.byteLength);
    chunk.copyTo(data);
    const key = chunk.type === "key";
    const us = this.captureOf.get(chunk.timestamp) ?? nowUS();
    this.captureOf.delete(chunk.timestamp);
    try {
      if (key) {
        this.dropping = false;
        await this.stream?.close().catch(() => {});
        // Lower layers first on a congested uplink (higher sendOrder = sooner).
        const s = await this.c.wt.createUnidirectionalStream({ sendOrder: 100 - this.spec.id } as WebTransportSendStreamOptions);
        this.stream = s.getWriter();
        this.group++;
        void this.stream.write(groupHeader(this.trackId, this.spec.id, this.group));
      } else if (!this.stream || this.dropping) {
        return;
      }
      const w = this.stream!;
      if ((w.desiredSize ?? 1) < -(1 << 20)) {
        // The uplink is backed up: drop until the next keyframe (and ask for one soon).
        this.dropping = true;
        this.force = true;
        return;
      }
      const aud = Uint8Array.of(0, 0, 0, 1, 9, 0xf0);
      void w.write(frameHeader(key, us, aud.length + data.length));
      void w.write(aud);
      void w.write(data);
      this.sent++; // boson
    } catch {
      this.stream = null;
      this.force = true;
    }
  }

  close(): void {
    void this.stream?.close().catch(() => {});
    this.closed = true;
    if (this.enc.state !== "closed") this.enc.close();
  }
}

/** What this browser can do with quicvideo. */
export interface VideoSupport {
  /** Can join and watch (WebTransport + H.264 decode). */
  watch: boolean;
  /** Can also send camera/screen (H.264 encode). */
  send: boolean;
  /** What's missing, for a message ("WebTransport", "H.264 decoding"...). */
  missing: string[];
}

/** Checks WebTransport and WebCodecs H.264 (decode, and encode for sending). */
export async function videoSupport(): Promise<VideoSupport> {
  const missing: string[] = [];
  const g = globalThis as Record<string, unknown>;
  const wt = typeof g.WebTransport === "function";
  if (!wt) missing.push("WebTransport");
  let dec = false;
  if (typeof g.VideoDecoder !== "function") missing.push("WebCodecs VideoDecoder");
  else {
    dec = await VideoDecoder.isConfigSupported({ codec: "avc1.42e01f" }).then((r) => !!r.supported, () => false);
    if (!dec) missing.push("H.264 decoding");
  }
  let enc = false;
  if (typeof g.VideoEncoder !== "function") missing.push("WebCodecs VideoEncoder");
  else {
    enc = await VideoEncoder.isConfigSupported({
      codec: "avc1.42e01f", width: 640, height: 360, avc: { format: "annexb" },
    } as VideoEncoderConfig).then((r) => !!r.supported, () => false);
    if (!enc) missing.push("H.264 encoding");
  }
  const watch = wt && dec;
  return { watch, send: watch && enc, missing };
}

export { TrackKind };
export type { Layer, Track };
