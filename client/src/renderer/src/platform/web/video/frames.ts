// The frame socket's messages, made in the page (the desktop makes them in
// Go: desktop/video_avc.go, video_hub.go), so the call view's decoder
// (modules/video/video.controller.ts, video.frames.ts) gets the same bytes:
// H.264 as AVC (an avcC description on keyframes, 4-byte length-prefixed
// NAL units) from quicvideo's Annex B, and the self-view's RGBA previews.

const NAL_IDR = 5;
const NAL_SPS = 7;
const NAL_PPS = 8;
const NAL_AUD = 9;

export interface AvcFrame {
  data: Uint8Array; // length-prefixed NAL units (no SPS/PPS/AUD)
  desc: Uint8Array | null; // avcC when the unit carried SPS and PPS
  keyframe: boolean;
}

/** The NAL units of an Annex-B stream, without start codes. */
export function splitAnnexB(b: Uint8Array): Uint8Array[] {
  const out: Uint8Array[] = [];
  let start = -1;
  let i = 0;
  while (i + 2 < b.length) {
    if (b[i] === 0 && b[i + 1] === 0 && (b[i + 2] === 1 || (b[i + 2] === 0 && i + 3 < b.length && b[i + 3] === 1))) {
      const sc = b[i + 2] === 0 ? 4 : 3;
      if (start >= 0) out.push(trimZeros(b.subarray(start, i)));
      i += sc;
      start = i;
      continue;
    }
    i++;
  }
  if (start >= 0 && start < b.length) out.push(b.subarray(start));
  return out;
}

function trimZeros(n: Uint8Array): Uint8Array {
  let e = n.length;
  while (e > 0 && n[e - 1] === 0) e--;
  return n.subarray(0, e);
}

/** An AVCDecoderConfigurationRecord with one SPS and one PPS, 4-byte lengths. */
export function avcC(sps: Uint8Array, pps: Uint8Array): Uint8Array | null {
  if (sps.length < 4) return null;
  const out = new Uint8Array(6 + 2 + sps.length + 1 + 2 + pps.length);
  out.set([1, sps[1]!, sps[2]!, sps[3]!, 0xff, 0xe1]);
  let o = 6;
  out[o++] = sps.length >> 8;
  out[o++] = sps.length & 0xff;
  out.set(sps, o);
  o += sps.length;
  out[o++] = 1;
  out[o++] = pps.length >> 8;
  out[o++] = pps.length & 0xff;
  out.set(pps, o);
  return out;
}

/** Converts an Annex-B access unit; null when it has no picture NALs. */
export function toAVC(au: Uint8Array): AvcFrame | null {
  let sps: Uint8Array | null = null;
  let pps: Uint8Array | null = null;
  let keyframe = false;
  const parts: Uint8Array[] = [];
  let size = 0;
  for (const nal of splitAnnexB(au)) {
    if (nal.length === 0) continue;
    const t = nal[0]! & 0x1f;
    if (t === NAL_AUD) continue;
    if (t === NAL_SPS) { sps = nal; continue; }
    if (t === NAL_PPS) { pps = nal; continue; }
    if (t === NAL_IDR) keyframe = true;
    parts.push(nal);
    size += 4 + nal.length;
  }
  if (parts.length === 0) return null;
  const data = new Uint8Array(size);
  const v = new DataView(data.buffer);
  let o = 0;
  for (const p of parts) {
    v.setUint32(o, p.length);
    data.set(p, o + 4);
    o += 4 + p.length;
  }
  return { data, desc: sps && pps ? avcC(sps, pps) : null, keyframe };
}

const FRAME = 1;
const PREVIEW = 2;
const HEADER = 20;

/** A frame message (video.frames.ts parseBinary). */
export function encodeFrameMsg(trackId: number, layer: number, captureUS: number, f: AvcFrame): ArrayBuffer {
  const desc = f.desc ?? new Uint8Array(0);
  const buf = new ArrayBuffer(HEADER + desc.length + f.data.length);
  const b = new Uint8Array(buf);
  const v = new DataView(buf);
  b[0] = FRAME;
  b[1] = (f.keyframe ? 1 : 0) | (desc.length > 0 ? 2 : 0);
  v.setUint32(2, trackId);
  v.setUint32(6, layer);
  v.setBigUint64(10, BigInt(Math.max(0, Math.round(captureUS))));
  v.setUint16(18, desc.length);
  b.set(desc, HEADER);
  b.set(f.data, HEADER + desc.length);
  return buf;
}

/** A self-view picture (RGBA). */
export function encodePreviewMsg(w: number, h: number, rgba: Uint8ClampedArray): ArrayBuffer {
  const buf = new ArrayBuffer(5 + rgba.length);
  const b = new Uint8Array(buf);
  b.set([PREVIEW, w >> 8, w & 0xff, h >> 8, h & 0xff]);
  b.set(rgba, 5);
  return buf;
}
