import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { MessageSquare, MicOff, Pin, PhoneOff } from 'lucide-preact';
import { layout, phoneLayout, useVideo, type Corner, type Rect, type VideoTrack } from '../../modules/video';
import { useVoice } from '../../modules/voice';
import { CallVideoButtons } from './CallControls';
import './CallView.css';

// A tile: a person (their camera, or their avatar when audio-only, or our
// self-view), or a screen share of its own.
interface Tile {
  key: string;
  name: string;
  speaking: boolean;
  muted: boolean;
  track?: VideoTrack; // a received camera or screen
  self?: boolean; // our own camera (drawn from the self-view)
  screen?: boolean;
  aspect?: number; // the video's width/height (its biggest layer)
}

function aspectOf(t?: VideoTrack): number | undefined {
  const l = t?.layers.reduce((a, b) => (b.width * b.height > a.width * a.height ? b : a), t.layers[0]);
  return l && l.width > 0 && l.height > 0 ? l.width / l.height : undefined;
}

// The call: everyone in the voice channel as tiles. Screen shares get the
// big tile; cameras and avatars share the rest (at most 9 shown, the rest
// not received). Video is received only while this view is open, each
// track at the size its tile needs.
//
// On a phone (`phone`): no header (MobileCallBar is the call's one bar),
// and phoneLayout: the other person big with ourselves as a picture-in-
// picture that can be dragged to any corner, 2×2 for three or four, a
// scrolling two-column list beyond, screen shares on top at their aspect.
export function CallView({ avatarFor, phone = false }: { avatarFor?: (nick: string) => string | undefined; phone?: boolean }) {
  const { video, snap } = useVideo();
  const { voice, snap: vsnap } = useVoice();
  // The stage is measured whenever it's (re)mounted: it isn't there while
  // video isn't available yet.
  const [stageEl, setStageEl] = useState<HTMLDivElement | null>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [corner, setCorner] = useState<Corner>('br');
  const call = vsnap.call;

  useEffect(() => {
    const el = stageEl;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setSize({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, [stageEl]);

  const tracks = snap.state.tracks;
  const tiles: Tile[] = [];
  for (const t of tracks) {
    if (t.kind === 'screen' && !t.self) tiles.push({ key: `t${t.trackId}`, name: `${t.name}’s screen`, speaking: false, muted: false, track: t, screen: true, aspect: aspectOf(t) });
  }
  let selfKey: string | null = null;
  for (const p of call.participants) {
    const cam = tracks.find((t) => t.kind === 'camera' && t.userId === p.userId && !t.self);
    const selfCam = p.self && snap.state.camera.on;
    const key = cam ? `t${cam.trackId}` : `p${p.sessionId}`;
    if (p.self) selfKey = key;
    tiles.push({
      key,
      name: p.self ? `${p.name} (you)` : p.name,
      speaking: p.speaking,
      muted: p.muted,
      track: cam,
      self: selfCam,
      aspect: aspectOf(cam),
    });
  }
  const bigId = video?.bigTile() ?? 0;
  const big = bigId ? tiles.find((t) => t.track?.trackId === bigId)?.key ?? null : null;
  const pl = phone
    ? phoneLayout(tiles.map((t) => ({ key: t.key, screen: t.screen, self: t.key === selfKey, video: !!t.track || !!t.self, aspect: t.aspect ?? (t.self ? 3 / 4 : undefined) })), size.w, size.h, corner)
    : null;
  const rects = pl ? pl.rects : layout(tiles.map((t) => t.key), big, size.w, size.h);

  // Receive what's visible, sized to its tile.
  useLayoutEffect(() => {
    if (!video) return;
    const dpr = globalThis.devicePixelRatio || 1;
    const visible = document.visibilityState === 'visible';
    video.tiles(tiles.filter((t) => t.track).map((t) => {
      const r = rects.get(t.key);
      return { trackId: t.track!.trackId, width: (r?.w ?? 0) * dpr, height: (r?.h ?? 0) * dpr, visible: visible && !!r };
    }));
  });

  if (!video || !snap.state.available) return null;
  const cam = snap.state.camera;
  const scr = snap.state.screen;
  const notice = phone ? (!cam.paused && cam.error) || scr.error : '';

  return (
    <main class="call-view" aria-label="Call" data-phone={phone || undefined}>
      {!phone && <header class="call-view-head">
        <span class="call-view-title">{call.roomName || call.room}</span>
        <span class="call-view-count">{call.participants.length} in call</span>
        <span class="call-view-actions">
          <CallVideoButtons withCallToggle={false} />
          <button type="button" class="voice-bar-btn" aria-label="Back to chat" title="Back to chat" onClick={() => video.setOpen(false)}>
            <MessageSquare size={16} aria-hidden="true" />
          </button>
          <button type="button" class="voice-bar-btn voice-bar-leave" aria-label="Leave the call" title="Leave the call"
            onClick={() => { video.setOpen(false); void voice?.leave(); }}>
            <PhoneOff size={16} aria-hidden="true" />
          </button>
        </span>
      </header>}
      {notice && <div class="call-view-notice" role="status">{notice}</div>}
      <div class="call-stage" ref={setStageEl}>
        <div class="call-stage-content" style={pl && pl.height > size.h ? { height: `${pl.height}px` } : undefined}>
          {tiles.map((t) => (
            <CallTile key={t.key} tile={t} rect={rects.get(t.key) ?? null} big={t.key === big} avatar={avatarFor?.(t.name)}
              mirror={!!t.self && cam.facing !== 'back'}
              fit={phone && !t.screen ? 'cover' : 'contain'}
              pip={pl?.pip === t.key ? { stage: size, onDrop: setCorner } : undefined}
              onPin={t.track && !phone ? () => video.pin(t.track!.trackId) : undefined}
              canvasRef={(el) => { if (t.track) video.attachCanvas(t.track.trackId, el); else if (t.self) video.attachPreview(el); }} />
          ))}
        </div>
      </div>
    </main>
  );
}

// The picture-in-picture follows a finger and settles in the nearest
// corner when let go.
interface PipDrag {
  stage: { w: number; h: number };
  onDrop: (c: Corner) => void;
}

// mirror: our own preview of a front camera (or a webcam) is mirrored, as
// in a mirror; a back camera's never is. What's sent is never mirrored.
function CallTile({ tile, rect, big, avatar, fit, mirror, pip, onPin, canvasRef }: {
  tile: Tile; rect: Rect | null; big: boolean; avatar?: string; fit: 'cover' | 'contain'; mirror: boolean; pip?: PipDrag;
  onPin?: () => void; canvasRef: (el: HTMLCanvasElement | null) => void;
}) {
  const [drag, setDrag] = useState<{ dx: number; dy: number } | null>(null);
  const start = useRef<{ x: number; y: number; id: number } | null>(null);
  if (!rect) return null;
  const showVideo = !!tile.track || !!tile.self;
  const pipHandlers = pip ? {
    onPointerDown: (e: PointerEvent) => {
      start.current = { x: e.clientX, y: e.clientY, id: e.pointerId };
      (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    },
    onPointerMove: (e: PointerEvent) => {
      const s = start.current;
      if (s && s.id === e.pointerId) setDrag({ dx: e.clientX - s.x, dy: e.clientY - s.y });
    },
    onPointerUp: (e: PointerEvent) => {
      const s = start.current;
      start.current = null;
      if (!s || !drag) { setDrag(null); return; }
      const cx = rect.x + rect.w / 2 + (e.clientX - s.x);
      const cy = rect.y + rect.h / 2 + (e.clientY - s.y);
      pip.onDrop(`${cy < pip.stage.h / 2 ? 't' : 'b'}${cx < pip.stage.w / 2 ? 'l' : 'r'}` as Corner);
      setDrag(null);
    },
    onPointerCancel: () => { start.current = null; setDrag(null); },
  } : {};
  return (
    <div class="call-tile" data-speaking={tile.speaking || undefined} data-big={big || undefined} data-screen={tile.screen || undefined}
      data-pip={pip ? true : undefined}
      style={{ left: `${rect.x}px`, top: `${rect.y}px`, width: `${rect.w}px`, height: `${rect.h}px`,
        ...(drag ? { transform: `translate(${drag.dx}px, ${drag.dy}px)`, transition: 'none' } : {}) }}
      aria-label={tile.name} {...pipHandlers}>
      {showVideo ? (
        <canvas class="call-tile-video" ref={canvasRef} data-fit={fit} data-mirror={mirror || undefined} />
      ) : (
        <span class="call-tile-avatar" aria-hidden="true">
          {avatar ? <img src={avatar} alt="" /> : <span>{tile.name.slice(0, 1).toUpperCase()}</span>}
        </span>
      )}
      <span class="call-tile-label">
        {tile.muted && <MicOff size={12} aria-label="muted" />}
        {tile.name}
      </span>
      {onPin && (
        <button type="button" class="call-tile-pin" aria-pressed={big} aria-label={big ? 'Unpin' : 'Show big'} title={big ? 'Unpin' : 'Show big'} onClick={onPin}>
          <Pin size={13} aria-hidden="true" />
        </button>
      )}
    </div>
  );
}
