import { useEffect, useLayoutEffect, useState } from 'preact/hooks';
import { MessageSquare, MicOff, Pin, PhoneOff } from 'lucide-preact';
import { layout, useVideo, type Rect, type VideoTrack } from '../../modules/video';
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
}

// The call: everyone in the voice channel as tiles. Screen shares get the
// big tile; cameras and avatars share the rest (at most 9 shown, the rest
// not received). Video is received only while this view is open, each
// track at the size its tile needs.
export function CallView({ avatarFor }: { avatarFor?: (nick: string) => string | undefined }) {
  const { video, snap } = useVideo();
  const { voice, snap: vsnap } = useVoice();
  // The stage is measured whenever it's (re)mounted: it isn't there while
  // video isn't available yet.
  const [stageEl, setStageEl] = useState<HTMLDivElement | null>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
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
    if (t.kind === 'screen' && !t.self) tiles.push({ key: `t${t.trackId}`, name: `${t.name}’s screen`, speaking: false, muted: false, track: t, screen: true });
  }
  for (const p of call.participants) {
    const cam = tracks.find((t) => t.kind === 'camera' && t.userId === p.userId && !t.self);
    const selfCam = p.self && snap.state.camera.on;
    tiles.push({
      key: cam ? `t${cam.trackId}` : `p${p.sessionId}`,
      name: p.self ? `${p.name} (you)` : p.name,
      speaking: p.speaking,
      muted: p.muted,
      track: cam,
      self: selfCam,
    });
  }
  const bigId = video?.bigTile() ?? 0;
  const big = bigId ? tiles.find((t) => t.track?.trackId === bigId)?.key ?? null : null;
  const rects = layout(tiles.map((t) => t.key), big, size.w, size.h);

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

  return (
    <main class="call-view" aria-label="Call">
      <header class="call-view-head">
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
      </header>
      <div class="call-stage" ref={setStageEl}>
        {tiles.map((t) => (
          <CallTile key={t.key} tile={t} rect={rects.get(t.key) ?? null} big={t.key === big} avatar={avatarFor?.(t.name)}
            onPin={t.track ? () => video.pin(t.track!.trackId) : undefined}
            canvasRef={(el) => { if (t.track) video.attachCanvas(t.track.trackId, el); else if (t.self) video.attachPreview(el); }} />
        ))}
      </div>
    </main>
  );
}

function CallTile({ tile, rect, big, avatar, onPin, canvasRef }: {
  tile: Tile; rect: Rect | null; big: boolean; avatar?: string;
  onPin?: () => void; canvasRef: (el: HTMLCanvasElement | null) => void;
}) {
  if (!rect) return null;
  const showVideo = !!tile.track || !!tile.self;
  return (
    <div class="call-tile" data-speaking={tile.speaking || undefined} data-big={big || undefined} data-screen={tile.screen || undefined}
      style={{ left: `${rect.x}px`, top: `${rect.y}px`, width: `${rect.w}px`, height: `${rect.h}px` }}
      aria-label={tile.name}>
      {showVideo ? (
        <canvas class="call-tile-video" ref={canvasRef} data-mirror={tile.self || undefined} />
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
