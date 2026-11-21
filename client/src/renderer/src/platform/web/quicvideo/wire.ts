// Copied from boson-chat/quicvideo@v1.14.0 (80ae103) web/src (wire.ts). Keep in sync; local changes are marked "boson:".
// quicvideo wire format (docs/protocol.md): varint-framed protobuf control
// messages, and media streams of [track, layer, group] + frames.
import { fromBinary, toBinary } from "@bufbuild/protobuf";
import { type ControlMessage, ControlMessageSchema } from "./gen/quicvideo/v1/control_pb";

export const MAX_FRAME = 4 << 20;
export const FLAG_KEYFRAME = 1;

export function appendVarint(out: number[], v: number | bigint): void {
  let n = BigInt(v);
  while (n >= 0x80n) {
    out.push(Number(n & 0x7fn) | 0x80);
    n >>= 7n;
  }
  out.push(Number(n));
}

export function encodeControl(m: ControlMessage): Uint8Array {
  const body = toBinary(ControlMessageSchema, m);
  const head: number[] = [];
  appendVarint(head, body.length);
  const out = new Uint8Array(head.length + body.length);
  out.set(head, 0);
  out.set(body, head.length);
  return out;
}

export function groupHeader(track: number, layer: number, group: bigint): Uint8Array {
  const b: number[] = [];
  appendVarint(b, track);
  appendVarint(b, layer);
  appendVarint(b, group);
  return Uint8Array.from(b);
}

export function frameHeader(keyframe: boolean, captureUS: bigint, len: number): Uint8Array {
  const b: number[] = [keyframe ? FLAG_KEYFRAME : 0];
  appendVarint(b, captureUS);
  appendVarint(b, len);
  return Uint8Array.from(b);
}

/** Buffered reader over a ReadableStream of bytes (varints, exact reads). */
export class ByteReader {
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

  /** Next byte, or -1 at a clean end of stream. */
  async byte(): Promise<number> {
    while (this.off >= this.buf.length) if (!(await this.fill())) return -1;
    return this.buf[this.off++];
  }

  async varint(): Promise<bigint | null> {
    let v = 0n;
    for (let shift = 0n; shift < 70n; shift += 7n) {
      const b = await this.byte();
      if (b < 0) {
        if (shift === 0n) return null;
        throw new Error("truncated varint");
      }
      v |= BigInt(b & 0x7f) << shift;
      if (b < 0x80) return v;
    }
    throw new Error("varint overflow");
  }

  async exact(n: number): Promise<Uint8Array> {
    while (this.buf.length - this.off < n) if (!(await this.fill())) throw new Error("truncated stream");
    const out = this.buf.slice(this.off, this.off + n);
    this.off += n;
    return out;
  }

  cancel(reason?: unknown): void {
    this.reader.cancel(reason).catch(() => {});
  }
}

export async function readControl(r: ByteReader): Promise<ControlMessage | null> {
  const n = await r.varint();
  if (n === null) return null;
  if (n > 64n << 10n) throw new Error("control message too large");
  return fromBinary(ControlMessageSchema, await r.exact(Number(n)));
}

export interface MediaFrame {
  keyframe: boolean;
  captureUS: bigint;
  payload: Uint8Array;
}

/** Reads one frame of a media stream (null at the group's end). */
export async function readFrame(r: ByteReader): Promise<MediaFrame | null> {
  const flags = await r.byte();
  if (flags < 0) return null;
  const ts = await r.varint();
  const len = await r.varint();
  if (ts === null || len === null) throw new Error("truncated frame");
  if (len > BigInt(MAX_FRAME)) throw new Error("frame too large");
  return { keyframe: (flags & FLAG_KEYFRAME) !== 0, captureUS: ts, payload: await r.exact(Number(len)) };
}
