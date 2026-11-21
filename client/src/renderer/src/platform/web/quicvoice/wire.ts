// Copied from boson-chat/quicvoice@v1.15.0 web/src (wire.ts). Keep in sync; local changes are marked "boson:".
// quicvoice wire format (docs/PROTOCOL.md): varint-framed protobuf control
// messages on one bidirectional stream, and audio/ping datagrams. The same
// bytes as the Go SDK (wire/), so this file is meant to be copied as is
// into browser apps (Boson's web client uses it).
import { fromBinary, toBinary } from "@bufbuild/protobuf";
import { type ControlMessage, ControlMessageSchema } from "./gen/control_pb";

export const VERSION = 1;

export enum Kind {
  Uplink = 0x0,
  Downlink = 0x1,
  Ping = 0x2,
}

export const FLAG_START = 1 << 0; // first frame of a talk spurt
export const FLAG_END = 1 << 1; // last frame of a talk spurt
export const FLAG_LOST_PREV = 1 << 2; // the encoder dropped frames before this one

export const UPLINK_HEADER_LEN = 10;
export const DOWNLINK_HEADER_LEN = 12;
export const PING_LEN = 9;
export const LEVEL_SILENCE = 127;
const MAX_CONTROL = 64 << 10;

/** Fields shared by uplink and downlink audio datagrams. */
export interface Audio {
  flags: number;
  voice: boolean; // sender VAD
  level: number; // -dBov, 0 loudest .. 127 silence
  seq: number; // u16
  timestamp: number; // u32, 48 kHz sample clock
  payload: Uint8Array; // one Opus frame
}

export interface Uplink extends Audio {
  target: number; // 0 = room
}

export interface Downlink extends Audio {
  targetKind: number;
  sessionId: number; // u16
}

export interface Ping {
  reply: boolean;
  id: number; // u16
  sentUS: number; // u32, sender's clock (µs, wrapping)
}

export function peek(b: Uint8Array): { version: number; kind: Kind } | null {
  if (b.length < 1) return null;
  return { version: b[0] >> 4, kind: (b[0] & 0x0f) as Kind };
}

function levelByte(voice: boolean, level: number): number {
  const l = Math.min(Math.max(level | 0, 0), LEVEL_SILENCE);
  return voice ? 0x80 | l : l;
}

export function encodeUplink(u: Uplink): Uint8Array {
  const out = new Uint8Array(UPLINK_HEADER_LEN + u.payload.length);
  const dv = new DataView(out.buffer);
  out[0] = (VERSION << 4) | Kind.Uplink;
  out[1] = u.flags & 0xff;
  out[2] = levelByte(u.voice, u.level);
  out[3] = u.target & 0xff;
  dv.setUint16(4, u.seq & 0xffff);
  dv.setUint32(6, u.timestamp >>> 0);
  out.set(u.payload, UPLINK_HEADER_LEN);
  return out;
}

function check(b: Uint8Array, kind: Kind, n: number): void {
  if (b.length < n) throw new Error("wire: datagram too short");
  if (b[0] >> 4 !== VERSION) throw new Error("wire: unsupported version");
  if ((b[0] & 0x0f) !== kind) throw new Error("wire: unexpected kind");
}

export function decodeDownlink(b: Uint8Array): Downlink {
  check(b, Kind.Downlink, DOWNLINK_HEADER_LEN);
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  return {
    flags: b[1],
    voice: (b[2] & 0x80) !== 0,
    level: b[2] & 0x7f,
    targetKind: b[3],
    sessionId: dv.getUint16(4),
    seq: dv.getUint16(6),
    timestamp: dv.getUint32(8),
    payload: b.subarray(DOWNLINK_HEADER_LEN),
  };
}

export function encodePing(p: Ping): Uint8Array {
  const out = new Uint8Array(PING_LEN);
  const dv = new DataView(out.buffer);
  out[0] = (VERSION << 4) | Kind.Ping;
  out[1] = p.reply ? 1 : 0;
  dv.setUint16(2, p.id & 0xffff);
  dv.setUint32(4, p.sentUS >>> 0);
  return out;
}

export function decodePing(b: Uint8Array): Ping {
  check(b, Kind.Ping, PING_LEN);
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  return { reply: (b[1] & 1) !== 0, id: dv.getUint16(2), sentUS: dv.getUint32(4) };
}

// ---- control stream ---------------------------------------------------------

function appendVarint(out: number[], v: number): void {
  while (v >= 0x80) {
    out.push((v & 0x7f) | 0x80);
    v = Math.floor(v / 128);
  }
  out.push(v);
}

/** One control message, framed as [uvarint length][protobuf]. */
export function encodeControl(m: ControlMessage): Uint8Array {
  const body = toBinary(ControlMessageSchema, m);
  const head: number[] = [];
  appendVarint(head, body.length);
  const out = new Uint8Array(head.length + body.length);
  out.set(head, 0);
  out.set(body, head.length);
  return out;
}

/** Reads framed control messages from a WebTransport stream. */
export class ControlReader {
  private buf = new Uint8Array(0);
  private off = 0;
  private reader: ReadableStreamDefaultReader<Uint8Array>;
  constructor(stream: ReadableStream<Uint8Array>) {
    this.reader = stream.getReader();
  }

  private async fill(): Promise<boolean> {
    const { value, done } = await this.reader.read();
    if (done || !value) return false;
    const rest = this.buf.subarray(this.off);
    const nb = new Uint8Array(rest.length + value.length);
    nb.set(rest, 0);
    nb.set(value, rest.length);
    this.buf = nb;
    this.off = 0;
    return true;
  }

  private async byte(): Promise<number> {
    while (this.off >= this.buf.length) if (!(await this.fill())) return -1;
    return this.buf[this.off++];
  }

  /** The next message, or null at a clean end of stream. */
  async read(): Promise<ControlMessage | null> {
    let n = 0;
    let mul = 1;
    for (let i = 0; ; i++) {
      const b = await this.byte();
      if (b < 0) {
        if (i === 0) return null;
        throw new Error("truncated varint");
      }
      n += (b & 0x7f) * mul;
      if (b < 0x80) break;
      mul *= 128;
      if (i > 4) throw new Error("varint overflow");
    }
    if (n > MAX_CONTROL) throw new Error("control message too large");
    while (this.buf.length - this.off < n) if (!(await this.fill())) throw new Error("truncated stream");
    const body = this.buf.slice(this.off, this.off + n);
    this.off += n;
    return fromBinary(ControlMessageSchema, body);
  }

  cancel(reason?: unknown): void {
    this.reader.cancel(reason).catch(() => {});
  }
}
