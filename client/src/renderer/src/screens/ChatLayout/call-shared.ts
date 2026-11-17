import { useEffect, useState } from 'preact/hooks';
import { getVideoController, type VideoState, type VideoTrack } from '../../modules/video';
import { getVoiceController, type VoiceParticipant } from '../../modules/voice';
import { setVoiceUi } from './VoiceRooms';

// What the call's views share: the call clock, opening the call from
// anywhere (voice panel, title bar pill, in-call strip, sidebar), and the
// call's tiles.

/** "12:04" since the call connected (h:mm:ss past an hour); '' when not in
 * a call. Ticks once a second while shown. */
export function useCallClock(since: number): string {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!since) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [since]);
  return since ? formatClock(Math.max(0, now - since)) : '';
}

export function formatClock(ms: number): string {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${String(m).padStart(2, '0')}:${ss}`;
}

/** Show the call you're in (its voice channel's view). */
export function openCall(): void {
  const voice = getVoiceController();
  const snap = voice?.getSnapshot();
  const call = snap?.call;
  if (!call || !call.host || (call.status !== 'connected' && call.status !== 'connecting')) return;
  setVoiceUi({ view: { host: call.host, roomId: call.room, serverName: snap!.callServerName } });
  const video = getVideoController();
  if (video && video.getSnapshot().state.available) video.setOpen(true);
}

/** Back to the chat: the call goes on. */
export function closeCall(): void {
  setVoiceUi({ view: null });
  getVideoController()?.setOpen(false);
}

// A tile on the call's stage: a person (their camera, our self-view, or
// their avatar), or a screen share of its own.
export interface CallTileInfo {
  key: string;
  name: string; // the person (a screen's is its sharer)
  label: string; // what the tile says: "mira", "you", "kestrel's screen"
  self: boolean;
  speaking: boolean;
  muted: boolean;
  screen: boolean;
  track?: VideoTrack; // a received camera or screen
  selfCamera: boolean; // our own camera (the self-view)
  aspect?: number;
}

function aspectOf(t?: VideoTrack): number | undefined {
  const l = t?.layers.reduce((a, b) => (b.width * b.height > a.width * a.height ? b : a), t.layers[0]);
  return l && l.width > 0 && l.height > 0 ? l.width / l.height : undefined;
}

/** Screen shares first (they're what people are looking at), then everyone
 * in the call. */
export function callTiles(participants: readonly VoiceParticipant[], video: VideoState): CallTileInfo[] {
  const out: CallTileInfo[] = [];
  for (const t of video.tracks) {
    if (t.kind === 'screen' && !t.self) {
      out.push({ key: `t${t.trackId}`, name: t.name, label: `${t.name}’s screen`, self: false, speaking: false, muted: false, screen: true, track: t, selfCamera: false, aspect: aspectOf(t) });
    }
  }
  for (const p of participants) {
    const cam = video.tracks.find((t) => t.kind === 'camera' && t.userId === p.userId && !t.self);
    out.push({
      key: cam ? `t${cam.trackId}` : `p${p.sessionId}`,
      name: p.name,
      label: p.self ? 'you' : p.name,
      self: p.self,
      speaking: p.speaking,
      muted: p.muted || p.deafened,
      screen: false,
      track: p.self ? undefined : cam,
      selfCamera: p.self && video.camera.on,
      aspect: aspectOf(cam),
    });
  }
  return out;
}

/** The grid's columns and rows for n tiles: 2, 3 or 4 columns; past 12
 * tiles fixed 200px rows that scroll, so tiles never shrink to stamps. */
export function gridShape(n: number): { cols: number; rows: string } {
  return { cols: n <= 4 ? 2 : n <= 9 ? 3 : 4, rows: n > 12 ? '200px' : 'minmax(0, 1fr)' };
}
