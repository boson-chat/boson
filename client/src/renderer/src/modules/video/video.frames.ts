// The frame socket's messages (desktop/video_avc.go, video_hub.go).

export interface FrameMsg {
  kind: 'frame';
  keyframe: boolean;
  trackId: number;
  layer: number;
  captureUS: number; // sender's Unix µs (exact to well below a ms)
  desc?: Uint8Array; // avcC, on keyframes
  data: Uint8Array; // length-prefixed NAL units
}

export interface PreviewMsg {
  kind: 'preview';
  width: number;
  height: number;
  rgba: Uint8ClampedArray;
}

export interface SyncMsg {
  kind: 'sync';
  // trackId → local wall clock offset (µs): show a frame captured at C at
  // C + offset.
  offsets: Map<number, number>;
}

const FRAME = 1;
const PREVIEW = 2;
const HEADER = 20;

export function parseBinary(buf: ArrayBuffer): FrameMsg | PreviewMsg | null {
  const b = new Uint8Array(buf);
  if (b.length < 1) return null;
  const v = new DataView(buf);
  if (b[0] === FRAME && b.length >= HEADER) {
    const flags = b[1];
    const descLen = v.getUint16(18);
    if (HEADER + descLen > b.length) return null;
    return {
      kind: 'frame',
      keyframe: (flags & 1) !== 0,
      trackId: v.getUint32(2),
      layer: v.getUint32(6),
      captureUS: Number(v.getBigUint64(10)),
      desc: flags & 2 ? b.slice(HEADER, HEADER + descLen) : undefined,
      data: b.subarray(HEADER + descLen),
    };
  }
  if (b[0] === PREVIEW && b.length >= 5) {
    const width = (b[1] << 8) | b[2];
    const height = (b[3] << 8) | b[4];
    if (b.length !== 5 + width * height * 4) return null;
    return { kind: 'preview', width, height, rgba: new Uint8ClampedArray(buf, 5) };
  }
  return null;
}

export function parseText(text: string): SyncMsg | null {
  try {
    const m = JSON.parse(text) as { type?: string; offsets?: Record<string, number> };
    if (m.type !== 'sync' || !m.offsets) return null;
    return { kind: 'sync', offsets: new Map(Object.entries(m.offsets).map(([k, o]) => [Number(k), o])) };
  } catch {
    return null;
  }
}

/** The WebCodecs codec string for an avcC ("avc1.PPCCLL"). */
export function codecFromDesc(desc: Uint8Array | undefined): string {
  if (!desc || desc.length < 4) return 'avc1.42e01f';
  const hex = (n: number) => n.toString(16).padStart(2, '0');
  return `avc1.${hex(desc[1])}${hex(desc[2])}${hex(desc[3])}`;
}
