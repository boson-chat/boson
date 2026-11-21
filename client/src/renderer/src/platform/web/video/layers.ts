// Camera layer ladders per quality (quicvideo CameraLayersFor): auto tops
// out at 720p, data saver at 360p, high at 1080p.
import type { LayerSpec } from '../quicvideo/layers';

const even = (v: number): number => Math.max(v & ~1, 2);

function fit(w: number, h: number, maxW: number, maxH: number): [number, number] {
  const s = Math.min(1, maxW / w, maxH / h);
  return [even(Math.round(w * s)), even(Math.round(h * s))];
}

export function cameraLayersFor(w: number, h: number, fps: number, quality: string): LayerSpec[] {
  const [maxW, maxH, ceil] = quality === 'saver' ? [640, 360, 600_000] : quality === 'high' ? [1920, 1080, 4_000_000] : [1280, 720, 2_500_000];
  const [tw, th] = fit(w || 1280, h || 720, maxW, maxH);
  const f = Math.max(1, Math.min(fps || 30, 30));
  const steps: Array<[number, number, number]> = [
    [even(tw / 4), even(th / 4), Math.max(Math.floor(f / 2), 1)],
    [even(tw / 2), even(th / 2), f],
    [tw, th, f],
  ];
  const out: LayerSpec[] = [];
  steps.forEach(([lw, lh, lf], i) => {
    let br = Math.round((lw * lh * lf * 0.042) / 10_000) * 10_000;
    br = Math.min(Math.max(br, 100_000), ceil);
    if (i > 0 && br <= out[i - 1]!.bitrate) br = out[i - 1]!.bitrate + 50_000;
    out.push({ id: i, width: lw, height: lh, fps: lf, bitrate: br });
  });
  return out;
}

/** Whether a ticket (JWT) grants video.publish (shown buttons only; the server checks). */
export function ticketCanPublish(token: string): boolean {
  const parts = token.split('.');
  if (parts.length !== 3) return false;
  try {
    const b64 = parts[1]!.replace(/-/g, '+').replace(/_/g, '/');
    return atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4)).includes('"video.publish"');
  } catch {
    return false;
  }
}

/** The WebTransport URL of a ticket: webtransport_url, else from quic_url (quic://host:port). */
export function ticketWebTransportUrl(t: { webtransportUrl?: string; quicUrl?: string }): string | null {
  if (t.webtransportUrl) return t.webtransportUrl;
  if (!t.quicUrl) return null;
  try {
    const u = new URL(t.quicUrl.replace(/^quic:/, 'https:'));
    return `https://${u.hostname.includes(':') ? `[${u.hostname}]` : u.hostname}:${u.port || '7710'}/wt`;
  } catch {
    return null;
  }
}

/** A camera's kind from its label (the browser says nothing else). */
export function cameraKind(label: string): 'builtin' | 'external' | 'continuity' | 'virtual' {
  const l = label.toLowerCase();
  if (/virtual|obs|snap camera|detail|immersed|mmhmm|camo/.test(l)) return 'virtual';
  if (/iphone|continuity/.test(l)) return 'continuity';
  if (/facetime|built-in|builtin|integrated|internal/.test(l)) return 'builtin';
  return 'external';
}
