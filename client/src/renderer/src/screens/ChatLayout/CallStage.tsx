import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import { Headphones, HeadphoneOff, LayoutGrid, Lock, Mic, MicOff, PanelLeft, PhoneOff, Volume2 } from 'lucide-preact';
import { Button } from '@boson/shared';
import { getVideoController, useSelfNotice, useTrackNotice, useVideo } from '../../modules/video';
import type { VideoShareState } from '../../modules/video/video.types';
import { useVoice } from '../../modules/voice';
import { Avatar } from '../../shared/Avatar/Avatar';
import { CallVideoButtons } from './CallControls';
import { callTiles, closeCall, gridShape, isPrivateCall, useCallClock, type CallTileInfo } from './call-shared';
import { SharingBar } from './ScreenPicker';
import { GuestBadge } from './GuestBadge';
import { ShareSound } from './ShareSound';
import './CallStage.css';

// The call on a desktop, in the main column while you're on its voice
// channel: focus mode (a screen share or the pinned tile big, everyone
// else in a strip that scrolls sideways; click a tile to pin it) or grid
// mode (2, 3 or 4 columns by how many tiles; past 12, fixed rows that
// scroll). The dock: mic, camera, screen, deafen, then leave.
export function CallStage({ avatarFor }: { avatarFor?: (nick: string) => string | undefined }) {
  const { video, snap: vsnap } = useVideo();
  const { voice, snap } = useVoice();
  const call = snap.call;
  const clock = useCallClock(snap.callSince);
  const [mode, setMode] = useState<'focus' | 'grid'>('focus');
  const [pinned, setPinned] = useState<string | null>(null);
  const vstate = vsnap.state;
  const tiles = callTiles(call.participants, vstate);
  const focused = tiles.find((t) => t.key === pinned) ?? tiles[0] ?? null;
  const strip = focused ? tiles.filter((t) => t.key !== focused.key) : [];

  // Each tile reports its size: received video is sized to its tile.
  const sizes = useRef(new Map<string, { w: number; h: number }>());
  const [measured, setMeasured] = useState(0);
  const onSize = useCallback((key: string, w: number, h: number) => {
    const prev = sizes.current.get(key);
    if (prev && prev.w === w && prev.h === h) return;
    sizes.current.set(key, { w, h });
    setMeasured((n) => n + 1);
  }, []);
  useEffect(() => {
    if (!video || !vstate.available) return;
    const dpr = globalThis.devicePixelRatio || 1;
    const visible = document.visibilityState === 'visible';
    video.tiles(tiles.filter((t) => t.track).map((t) => {
      const s = sizes.current.get(t.key);
      return { trackId: t.track!.trackId, width: (s?.w ?? 0) * dpr, height: (s?.h ?? 0) * dpr, visible: visible && !!s && s.w > 0 };
    }));
  });
  void measured;

  const rtt = call.rttMs > 0 ? `${Math.round(call.rttMs)} ms` : '';
  const pin = (key: string) => { setPinned(key); setMode('focus'); };
  const grid = gridShape(tiles.length);
  const tile = (t: CallTileInfo, size: 'big' | 'strip' | 'grid') => {
    const el = (
      <StageTile key={t.key} tile={t} size={size} avatar={avatarFor?.(t.name)} mirror={t.selfCamera && vstate.camera.facing !== 'back'}
        onPin={size === 'big' ? undefined : () => pin(t.key)} onSize={onSize}
        camera={t.self ? vstate.camera : undefined} micProblem={t.self ? call.micProblem : undefined}
        canvasRef={(c) => { if (t.track) video?.attachCanvas(t.track.trackId, c); else if (t.selfCamera) video?.attachPreview(c); }} />
    );
    // A share with its sound: its volume and mute, next to the tile.
    if (!t.track?.sound) return el;
    return (
      <div key={t.key} class="share-cell">
        {el}
        <ShareSound track={t.track} compact={size === 'strip'} />
      </div>
    );
  };

  return (
    <main class="stage" aria-label={`Call in ${call.roomName || call.room}`}>
      <header class="stage-head">
        {isPrivateCall(call.room)
          ? <Lock size={16} class="stage-head-icon stage-head-icon-private" aria-hidden="true" />
          : <Volume2 size={20} class="stage-head-icon" aria-hidden="true" />}
        <span class="stage-title">{call.roomName || call.room}</span>
        <span class="stage-meta">{[isPrivateCall(call.room) ? 'private · 1:1' : `${call.participants.length} in call`, rtt, clock].filter(Boolean).join(' · ')}</span>
        <span class="stage-spacer" />
        <div role="group" aria-label="Layout" class="stage-layout">
          <Button variant="secondary" pressed={mode === 'focus'} aria-label="Focus layout" title="Focus" onClick={() => setMode('focus')}
            icon={<PanelLeft aria-hidden="true" />} />
          <Button variant="secondary" pressed={mode === 'grid'} aria-label="Grid layout" title="Grid" onClick={() => setMode('grid')}
            icon={<LayoutGrid aria-hidden="true" />} />
        </div>
      </header>
      <SharingBar />
      {mode === 'focus' && focused ? (
        <div class="stage-focus">
          <div class="stage-big">{tile(focused, 'big')}</div>
          {strip.length > 0 && (
            <div class="stage-strip" aria-label="Others in the call">
              {strip.map((t) => <div key={t.key} class="stage-strip-cell">{tile(t, 'strip')}</div>)}
            </div>
          )}
        </div>
      ) : (
        <div class="stage-grid" style={{ gridTemplateColumns: `repeat(${grid.cols}, minmax(0, 1fr))`, gridAutoRows: grid.rows }}>
          {tiles.map((t) => tile(t, 'grid'))}
        </div>
      )}
      <div role="toolbar" aria-label="Call controls" class="stage-dock">
        <Button variant="secondary" size="lg" pressed={call.muted}
          disabled={!!call.listener} aria-label={call.listener ? "Listen only: your mic isn't heard here" : call.muted ? 'Unmute' : 'Mute'}
          title={call.muted ? 'Unmute' : 'Mute'} onClick={() => { void voice?.setMuted(!call.muted); }}
          icon={call.muted || call.listener ? <MicOff aria-hidden="true" /> : <Mic aria-hidden="true" />} />
        <CallVideoButtons withCallToggle={false} size="lg" />
        <Button variant="secondary" size="lg" pressed={call.deafened}
          aria-label={call.deafened ? 'Undeafen' : 'Deafen'} title={call.deafened ? 'Undeafen' : 'Deafen'}
          onClick={() => { void voice?.setDeafened(!call.deafened); }}
          icon={call.deafened ? <HeadphoneOff aria-hidden="true" /> : <Headphones aria-hidden="true" />} />
        <span class="stage-dock-sep" aria-hidden="true" />
        <Button variant="danger" size="lg" aria-label="Leave call" title="Leave" onClick={() => { closeCall(); void voice?.leave(); }}
          icon={<PhoneOff aria-hidden="true" />} />
      </div>
    </main>
  );
}

function StageTile({ tile, size, avatar, mirror, onPin, onSize, canvasRef, camera, micProblem }: {
  tile: CallTileInfo; size: 'big' | 'strip' | 'grid'; avatar?: string; mirror: boolean;
  onPin?: () => void; onSize: (key: string, w: number, h: number) => void; canvasRef: (el: HTMLCanvasElement | null) => void;
  // Our own tile: the camera's state (its self-view notice) and why our mic isn't heard.
  camera?: VideoShareState; micProblem?: string;
}) {
  const [el, setEl] = useState<HTMLElement | null>(null);
  useEffect(() => {
    if (!el || typeof ResizeObserver === 'undefined') return;
    const report = () => onSize(tile.key, el.clientWidth, el.clientHeight);
    const ro = new ResizeObserver(report);
    ro.observe(el);
    report();
    return () => ro.disconnect();
  }, [el, tile.key]);
  const video = !!tile.track || tile.selfCamera;
  const notice = useTrackNotice(getVideoController(), tile.track?.trackId);
  // Ours: what's wrong with what we send (the camera first, then the mic).
  const selfCam = useSelfNotice(getVideoController(), camera, tile.selfCamera);
  const selfNotice = tile.self ? (selfCam ?? micProblem ?? null) : null;
  const body = (
    <>
      {video ? (
        <canvas class="stage-video" ref={canvasRef} data-fit={tile.screen ? 'contain' : 'cover'} data-mirror={mirror || undefined} />
      ) : (
        <span class="stage-avatar"><Avatar nick={tile.name} url={avatar} size={size === 'big' ? 110 : size === 'strip' ? 46 : 76} /></span>
      )}
      {tile.track && notice && <span class="video-notice" role="status">{notice}</span>}
      {selfNotice && <span class="video-notice video-notice-self" role="status">{selfNotice}</span>}
      <span class="stage-tag">
        {tile.screen && <span class="voice-live" aria-hidden="true">LIVE</span>}
        {tile.label}
        {tile.guest && <GuestBadge />}
        {tile.muted && <MicOff size={12} class="stage-muted" aria-label="muted" />}
      </span>
    </>
  );
  const attrs = { class: 'stage-tile', 'data-speaking': tile.speaking || undefined, 'data-screen': tile.screen || undefined, 'data-size': size };
  return onPin
    ? <button type="button" ref={setEl} {...attrs} aria-label={`Focus ${tile.label}`} onClick={onPin}>{body}</button>
    : <div ref={setEl} {...attrs} aria-label={tile.label}>{body}</div>;
}
