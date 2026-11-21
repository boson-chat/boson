// Copied from boson-chat/quicvoice@v1.15.0 web/src (client.ts). Keep in sync; local changes are marked "boson:".
// quicvoice browser client: the same protocol as the Go SDK (client/),
// over WebTransport. Transport only: Opus encode/decode, the jitter buffer
// and playout belong to the app (WebCodecs AudioEncoder/AudioDecoder).
import { create, type MessageInitShape } from "@bufbuild/protobuf";
import {
  type ControlMessage,
  ControlMessageSchema,
  type Participant,
  type RoomState,
  type Welcome,
} from "./gen/control_pb";
import {
  ControlReader,
  type Downlink,
  decodeDownlink,
  decodePing,
  encodeControl,
  encodePing,
  encodeUplink,
  Kind,
  peek,
  type Uplink,
} from "./wire";

export interface ConnectOptions {
  /** SHA-256 (hex) of a self-signed dev certificate (GET /v1/info dev_cert_hash). */
  certHash?: string;
  clientVersion?: string;
}

export interface Support {
  /** WebTransport sessions (Chrome, Edge, Firefox; not Linux WebKit). */
  webTransport: boolean;
  /** WebCodecs Opus encode + decode. */
  opus: boolean;
  missing: string[];
}

/** What this browser can do; checks Opus support asynchronously. */
export async function support(): Promise<Support> {
  const missing: string[] = [];
  const webTransport = typeof (globalThis as { WebTransport?: unknown }).WebTransport === "function";
  if (!webTransport) missing.push("WebTransport");
  let opus = false;
  try {
    const cfg = { codec: "opus", sampleRate: 48000, numberOfChannels: 1 };
    const g = globalThis as { AudioEncoder?: typeof AudioEncoder; AudioDecoder?: typeof AudioDecoder };
    if (g.AudioEncoder && g.AudioDecoder) {
      const [e, d] = await Promise.all([
        g.AudioEncoder.isConfigSupported({ ...cfg, bitrate: 32000 }),
        g.AudioDecoder.isConfigSupported(cfg),
      ]);
      opus = !!e.supported && !!d.supported;
    }
  } catch {
    opus = false;
  }
  if (!opus) missing.push("WebCodecs Opus");
  return { webTransport, opus, missing };
}

type Events = {
  audio: (d: Downlink) => void;
  joined: (p: Participant) => void;
  left: (sessionId: number, reason: string) => void;
  updated: (p: Participant) => void;
  speaking: (sessionId: number, speaking: boolean) => void;
  control: (m: ControlMessage) => void;
  error: (code: number, message: string, fatal: boolean) => void;
  closed: (reason: string) => void;
};

export class QuicVoiceError extends Error {
  constructor(readonly code: number, message: string, readonly fatal: boolean) {
    super(message);
  }
}

// The spec moved datagram writing to datagrams.createWritable() (WebKit has
// only that); Chromium and Firefox still have datagrams.writable.
function datagramWriter(wt: WebTransport): WritableStreamDefaultWriter<Uint8Array> {
  const d = wt.datagrams as WebTransportDatagramDuplexStream & { createWritable?: () => WritableStream<Uint8Array> };
  const w = typeof d.createWritable === "function" ? d.createWritable() : d.writable;
  return w.getWriter();
}

const hexToBytes = (hex: string) => Uint8Array.from(hex.match(/../g)!.map((b) => parseInt(b, 16)));
const nowUS = () => Math.round((performance.timeOrigin + performance.now()) * 1000);

export class QuicVoiceClient {
  readonly wt: WebTransport;
  welcome!: Welcome;
  room: RoomState | null = null;
  /** Smoothed datagram RTT from Ping echoes (ms; 0 until measured). */
  rttMs = 0;
  private ctrl!: WritableStreamDefaultWriter<Uint8Array>;
  private dgw!: WritableStreamDefaultWriter<Uint8Array>;
  private waiters: ((m: ControlMessage) => boolean)[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private listeners = new Map<keyof Events, ((...a: any[]) => void)[]>();
  private pingSeq = 0;
  private pingTimer: ReturnType<typeof setInterval> | null = null;

  private constructor(wt: WebTransport) {
    this.wt = wt;
  }

  /**
   * Connects to https://host:7700/wt and authenticates with a voice token
   * (the auth service's, or any string with AUTH_INSECURE).
   */
  static async connect(url: string, token: string, opts: ConnectOptions = {}): Promise<QuicVoiceClient> {
    const wtOpts: WebTransportOptions = {};
    if (opts.certHash) wtOpts.serverCertificateHashes = [{ algorithm: "sha-256", value: hexToBytes(opts.certHash) }];
    const wt = new WebTransport(url, wtOpts);
    await wt.ready;
    const c = new QuicVoiceClient(wt);
    const bidi = await wt.createBidirectionalStream();
    c.ctrl = bidi.writable.getWriter();
    c.dgw = datagramWriter(wt);
    const first = c.waitFor((m) => m.msg.case === "welcome" || m.msg.case === "error");
    void c.readControlLoop(new ControlReader(bidi.readable));
    void c.readDatagramLoop();
    wt.closed.then(
      (i) => c.finish(i.reason || "closed"),
      (e) => c.finish(String(e)),
    );
    await c.send({ case: "hello", value: { token, clientVersion: opts.clientVersion ?? "quicvoice-web/0.1" } });
    const m = await first;
    if (m.msg.case === "error") throw new QuicVoiceError(m.msg.value.code, m.msg.value.message, m.msg.value.fatal);
    if (m.msg.case === "welcome") c.welcome = m.msg.value;
    c.pingTimer = setInterval(() => c.ping(), 2000);
    return c;
  }

  on<K extends keyof Events>(ev: K, fn: Events[K]): () => void {
    this.listeners.set(ev, [...(this.listeners.get(ev) ?? []), fn]);
    return () => this.listeners.set(ev, (this.listeners.get(ev) ?? []).filter((f) => f !== fn));
  }

  private emit<K extends keyof Events>(ev: K, ...args: Parameters<Events[K]>): void {
    for (const fn of this.listeners.get(ev) ?? []) fn(...args);
  }

  async send(msg: MessageInitShape<typeof ControlMessageSchema>["msg"]): Promise<void> {
    await this.ctrl.write(encodeControl(create(ControlMessageSchema, { msg })));
  }

  /** Joins a room; resolves with its state (your session id, participants). */
  async join(room: string): Promise<RoomState> {
    const reply = this.waitFor((m) => m.msg.case === "roomState" || m.msg.case === "error");
    await this.send({ case: "join", value: { room } });
    const m = await reply;
    if (m.msg.case === "error") throw new QuicVoiceError(m.msg.value.code, m.msg.value.message, m.msg.value.fatal);
    this.room = m.msg.value as RoomState;
    return this.room;
  }

  async leave(): Promise<void> {
    this.room = null;
    await this.send({ case: "leave", value: {} });
  }

  async setMute(muted: boolean, deafened: boolean): Promise<void> {
    await this.send({ case: "setMute", value: { muted, deafened } });
  }

  /**
   * Sends one audio frame. Datagrams are unreliable: a full send queue
   * drops the frame rather than delaying the next ones.
   */
  sendAudio(u: Omit<Uplink, "target"> & { target?: number }): void {
    const max = this.welcome?.maxDatagramPayload || 1000;
    if (u.payload.length > max) throw new Error(`opus frame of ${u.payload.length} bytes > max ${max}`);
    void this.dgw.write(encodeUplink({ target: 0, ...u })).catch(() => {});
  }

  /** Reports when a frame's first sample was captured (lip sync). */
  async audioClock(timestamp: number, captureUS: number): Promise<void> {
    await this.send({ case: "audioClock", value: { timestamp, captureUs: BigInt(captureUS), version: 1 } });
  }

  close(reason = "bye"): void {
    try {
      this.wt.close({ closeCode: 0, reason });
    } catch {
      /* already closed */
    }
    this.finish(reason);
  }

  private ping(): void {
    const p = encodePing({ reply: false, id: ++this.pingSeq & 0xffff, sentUS: nowUS() >>> 0 });
    void this.dgw.write(p).catch(() => {});
  }

  waitFor(pred: (m: ControlMessage) => boolean, ms = 10_000): Promise<ControlMessage> {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("timed out waiting for the voice server")), ms);
      this.waiters.push((m) => {
        if (!pred(m)) return false;
        clearTimeout(t);
        resolve(m);
        return true;
      });
    });
  }

  private async readControlLoop(r: ControlReader): Promise<void> {
    try {
      for (;;) {
        const m = await r.read();
        if (!m) return this.finish("control stream closed");
        const i = this.waiters.findIndex((w) => w(m));
        if (i >= 0) this.waiters.splice(i, 1);
        this.dispatch(m);
      }
    } catch (e) {
      this.finish(String(e));
    }
  }

  private dispatch(m: ControlMessage): void {
    this.emit("control", m);
    switch (m.msg.case) {
      case "participantJoined":
        if (m.msg.value.participant) {
          this.room?.participants.push(m.msg.value.participant);
          this.emit("joined", m.msg.value.participant);
        }
        break;
      case "participantLeft": {
        const id = m.msg.value.sessionId;
        if (this.room) this.room.participants = this.room.participants.filter((p) => p.sessionId !== id);
        this.emit("left", id, m.msg.value.reason);
        break;
      }
      case "participantUpdated": {
        const p = m.msg.value.participant;
        if (p) {
          if (this.room) this.room.participants = this.room.participants.map((x) => (x.sessionId === p.sessionId ? p : x));
          this.emit("updated", p);
        }
        break;
      }
      case "speakingChanged":
        this.emit("speaking", m.msg.value.sessionId, m.msg.value.speaking);
        break;
      case "error":
        this.emit("error", m.msg.value.code, m.msg.value.message, m.msg.value.fatal);
        break;
    }
  }

  private async readDatagramLoop(): Promise<void> {
    const reader = this.wt.datagrams.readable.getReader();
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done || !value) return;
        const h = peek(value);
        if (!h) continue;
        try {
          if (h.kind === Kind.Downlink) this.emit("audio", decodeDownlink(value));
          else if (h.kind === Kind.Ping) {
            const p = decodePing(value);
            if (!p.reply) continue;
            const rtt = (((nowUS() >>> 0) - p.sentUS) >>> 0) / 1000;
            if (rtt < 10_000) this.rttMs = this.rttMs ? this.rttMs * 0.8 + rtt * 0.2 : rtt;
          }
        } catch {
          /* malformed datagram: drop */
        }
      }
    } catch {
      /* session closed */
    }
  }

  private closedOnce = false;
  private finish(reason: string): void {
    if (this.closedOnce) return;
    this.closedOnce = true;
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.emit("closed", reason);
  }
}
