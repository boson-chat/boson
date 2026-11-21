import { describe, expect, it } from 'vitest';
import { parseBinary, parseText } from '../../../modules/video/video.frames';
import { avcC, encodeFrameMsg, encodePreviewMsg, splitAnnexB, toAVC } from './frames';
import { FrameHub } from './frame-socket';
import { cameraKind, cameraLayersFor, ticketCanPublish, ticketWebTransportUrl } from './layers';

const sps = [0x67, 0x42, 0xe0, 0x1f, 0xaa];
const pps = [0x68, 0xce, 0x38];
const idr = [0x65, 0x88, 0x84];
const p = [0x41, 0x9a];

describe('Annex B → AVC', () => {
  it('splits 3- and 4-byte start codes and trims trailing zeros', () => {
    const b = Uint8Array.from([0, 0, 0, 1, ...sps, 0, 0, 0, 1, ...pps, 0, 0, 1, ...idr]);
    expect(splitAnnexB(b).map((n) => [...n])).toEqual([sps, pps, idr]);
  });

  it('makes an avcC + length-prefixed keyframe, dropping the AUD', () => {
    const au = Uint8Array.from([0, 0, 0, 1, 9, 0xf0, 0, 0, 0, 1, ...sps, 0, 0, 0, 1, ...pps, 0, 0, 0, 1, ...idr]);
    const f = toAVC(au)!;
    expect(f.keyframe).toBe(true);
    expect([...f.desc!]).toEqual([...avcC(Uint8Array.from(sps), Uint8Array.from(pps))!]);
    expect([...f.data]).toEqual([0, 0, 0, 3, ...idr]);
    const d = toAVC(Uint8Array.from([0, 0, 0, 1, ...p]))!;
    expect(d.keyframe).toBe(false);
    expect(d.desc).toBeNull();
    expect(toAVC(Uint8Array.from([0, 0, 0, 1, 9, 0xf0]))).toBeNull();
  });

  it('builds what the call view parses', () => {
    const f = toAVC(Uint8Array.from([0, 0, 0, 1, ...sps, 0, 0, 0, 1, ...pps, 0, 0, 0, 1, ...idr]))!;
    const m = parseBinary(encodeFrameMsg(7, 2, 1_700_000_000_123_456, f))!;
    expect(m.kind).toBe('frame');
    if (m.kind !== 'frame') return;
    expect(m.trackId).toBe(7);
    expect(m.layer).toBe(2);
    expect(m.keyframe).toBe(true);
    expect(m.captureUS).toBe(1_700_000_000_123_456);
    expect([...m.desc!]).toEqual([...f.desc!]);
    expect([...m.data]).toEqual([...f.data]);
    const pv = parseBinary(encodePreviewMsg(2, 1, new Uint8ClampedArray([1, 2, 3, 4, 5, 6, 7, 8])))!;
    expect(pv.kind).toBe('preview');
  });
});

describe('FrameHub', () => {
  it('delivers frames and sync to sockets, and keyframe requests back', async () => {
    const asked: number[] = [];
    const hub = new FrameHub({ keyframe: (id) => asked.push(id) });
    const Sock = hub.socketClass();
    const s = new Sock(hub.url);
    const got: unknown[] = [];
    s.onmessage = (ev: MessageEvent) => got.push(ev.data);
    await new Promise((r) => setTimeout(r, 0));
    expect(s.readyState).toBe(1);
    expect(hub.connected()).toBe(1);
    hub.frame(1, true, true, new ArrayBuffer(4));
    hub.broadcast(JSON.stringify({ type: 'sync', offsets: { 1: 5 } }));
    await new Promise((r) => setTimeout(r, 5));
    expect(got).toHaveLength(2);
    expect(parseText(got[1] as string)?.offsets.get(1)).toBe(5);
    s.send(JSON.stringify({ type: 'keyframe', trackId: 4 }));
    expect(asked).toEqual([4]);
    s.close();
    expect(hub.connected()).toBe(0);
  });

  it('skips a track to its next keyframe when a socket falls behind', async () => {
    const asked: number[] = [];
    const hub = new FrameHub({ keyframe: (id) => asked.push(id) });
    const s = new (hub.socketClass())(hub.url);
    let n = 0;
    s.onmessage = () => { n++; };
    for (let i = 0; i < 70; i++) hub.frame(3, false, false, new ArrayBuffer(1));
    expect(asked).toContain(3);
    await new Promise((r) => setTimeout(r, 5));
    expect(n).toBe(64);
    hub.frame(3, false, false, new ArrayBuffer(1)); // still skipping
    hub.frame(3, true, true, new ArrayBuffer(1)); // recovers on a keyframe with SPS/PPS
    await new Promise((r) => setTimeout(r, 5));
    expect(n).toBe(65);
  });
});

describe('video helpers', () => {
  it('ladders cameras per quality', () => {
    expect(cameraLayersFor(1920, 1080, 30, 'auto').at(-1)).toMatchObject({ width: 1280, height: 720 });
    expect(cameraLayersFor(1920, 1080, 30, 'saver').at(-1)).toMatchObject({ width: 640, height: 360 });
    expect(cameraLayersFor(1920, 1080, 30, 'high').at(-1)).toMatchObject({ width: 1920, height: 1080 });
    const l = cameraLayersFor(1280, 720, 30, 'auto');
    expect(l[1]!.bitrate).toBeGreaterThan(l[0]!.bitrate);
  });

  it('reads tickets', () => {
    const tok = (claims: object) => `x.${btoa(JSON.stringify(claims)).replace(/=+$/, '')}.y`;
    expect(ticketCanPublish(tok({ perms: ['video.publish'] }))).toBe(true);
    expect(ticketCanPublish(tok({ perms: [] }))).toBe(false);
    expect(ticketCanPublish('nope')).toBe(false);
    expect(ticketWebTransportUrl({ webtransportUrl: 'https://v.example:7710/wt' })).toBe('https://v.example:7710/wt');
    expect(ticketWebTransportUrl({ quicUrl: 'quic://v.example:7711' })).toBe('https://v.example:7711/wt');
    expect(ticketWebTransportUrl({})).toBeNull();
  });

  it('guesses camera kinds from labels', () => {
    expect(cameraKind('FaceTime HD Camera')).toBe('builtin');
    expect(cameraKind('OBS Virtual Camera')).toBe('virtual');
    expect(cameraKind("James's iPhone Camera")).toBe('continuity');
    expect(cameraKind('Logitech MX Brio')).toBe('external');
  });
});
