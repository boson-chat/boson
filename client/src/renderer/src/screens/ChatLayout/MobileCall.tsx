import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import {
  ChevronDown, ChevronUp, Ear, Headphones, HeadphoneOff, MessageSquare, Mic, MicOff, MonitorUp, MoreHorizontal, PhoneOff,
  RotateCw, SwitchCamera, Users, Video, VideoOff, Volume2, X,
} from 'lucide-preact';
import { getVideoController, useTrackNotice, useVideo, type VideoCamera } from '../../modules/video';
import { useVoice, type VoiceController, type VoiceState } from '../../modules/voice';
import { Avatar } from '../../shared/Avatar/Avatar';
import { BottomSheet } from './BottomSheet';
import { HoldToTalk, VoicePanel } from './MobileVoice';
import { callTiles, closeCall, openCall, type CallTileInfo } from './call-shared';
import { ShareSound } from './ShareSound';
import './MobileCall.css';

// The call on a phone: the call screen (header, stage, your own video as a
// corner picture, the dock in thumb reach, and More for the rest), and,
// minimized, a bar at the bottom of every screen while you're in a call.

type Corner = 'tl' | 'tr' | 'bl' | 'br';

/** The call screen. onChat: show the text channel the voice channel is
 * under (absent for a voice channel without one). */
export function MobileCallScreen({ avatarFor, onChat }: { avatarFor?: (nick: string) => string | undefined; onChat?: () => void }) {
  const { voice, snap } = useVoice();
  const { video, snap: vsnap } = useVideo();
  const call = snap.call;
  const vstate = vsnap.state;
  const [screenBig, setScreenBig] = useState(false);
  const [more, setMore] = useState(false);
  const [people, setPeople] = useState(false);
  const [corner, setCorner] = useState<Corner>('br');
  const tiles = callTiles(call.participants, vstate);
  const screenTile = tiles.find((t) => t.screen) ?? null;
  const remote = tiles.filter((t) => !t.screen && !t.self);
  const self = tiles.find((t) => t.self) ?? null;

  // Received video is sized to its tile.
  const sizes = useRef(new Map<string, { w: number; h: number }>());
  const [, setMeasured] = useState(0);
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
    const shown = screenBig && screenTile ? [screenTile] : tiles;
    video.tiles(shown.filter((t) => t.track).map((t) => {
      const s = sizes.current.get(t.key);
      return { trackId: t.track!.trackId, width: (s?.w ?? 0) * dpr, height: (s?.h ?? 0) * dpr, visible: visible && !!s && s.w > 0 };
    }));
  });
  if (!voice) return null;

  const rtt = call.rttMs > 0 ? `${Math.round(call.rttMs)} ms` : '';
  const cam = vstate.camera;
  const camLive = cam.on || cam.starting || !!cam.paused;
  const canSend = vstate.canCapture && vstate.canPublish && !call.listener;
  const canvas = (t: CallTileInfo) => (el: HTMLCanvasElement | null) => {
    if (t.track) video?.attachCanvas(t.track.trackId, el); else if (t.selfCamera) video?.attachPreview(el);
  };
  const remoteRows = remote.length > 4 ? '150px' : 'minmax(0, 1fr)';
  // A 1:1 call (one other person, no screen share): they fill the stage,
  // and you're the picture in the corner over it.
  const solo = remote.length === 1 && !screenTile;

  return (
    <main class="mcall" aria-label={`Call in ${call.roomName || call.room}`}>
      <header class="mcall-head">
        <button type="button" class="mcall-icon" aria-label="Minimize call" onClick={closeCall}><ChevronDown size={22} aria-hidden="true" /></button>
        <span class="mcall-dot" aria-hidden="true" />
        <span class="mcall-title">{call.roomName || call.room}</span>
        <span class="mcall-meta">· {call.participants.length}{rtt ? ` · ${rtt}` : ''}</span>
        {onChat && (
          <button type="button" class="mcall-icon" aria-label={`Chat in ${call.roomName || call.room}`} onClick={onChat}><MessageSquare size={20} aria-hidden="true" /></button>
        )}
      </header>
      <div class="mcall-stage">
        {screenTile?.track?.sound && <ShareSound track={screenTile.track} compact={!screenBig} cls="mcall-share-sound" />}
        {screenTile && screenBig ? (
          <MTile tile={screenTile} cls="mcall-screen-big" avatar={avatarFor?.(screenTile.name)} onSize={onSize} canvasRef={canvas(screenTile)}
            label={`${screenTile.label} · tap to shrink`} ariaLabel="Show everyone" onClick={() => setScreenBig(false)} />
        ) : (
          <>
            {screenTile && (
              <MTile tile={screenTile} cls="mcall-screen" avatar={avatarFor?.(screenTile.name)} onSize={onSize} canvasRef={canvas(screenTile)}
                label={screenTile.label} ariaLabel={`Enlarge ${screenTile.label}`} onClick={() => setScreenBig(true)} />
            )}
            <div class="mcall-grid" data-solo={solo || undefined} style={{ gridAutoRows: solo ? 'minmax(0, 1fr)' : remoteRows }}>
              {remote.map((t) => <MTile key={t.key} tile={t} cls="mcall-tile" avatar={avatarFor?.(t.name)} onSize={onSize} canvasRef={canvas(t)} label={t.label} />)}
              {remote.length === 0 && <div class="mcall-alone">You're the only one here.</div>}
            </div>
          </>
        )}
        {self && (
          <SelfPip tile={self} corner={corner} onCorner={setCorner} avatar={avatarFor?.(self.name)} facing={cam.facing}
            canvasRef={canvas(self)} />
        )}
      </div>
      {call.pushToTalk && !call.listener && <div class="mcall-ptt"><HoldToTalk voice={voice} call={call} compact /></div>}
      <div role="toolbar" aria-label="Call controls" class="mcall-dock">
        <button type="button" class="mcall-dock-btn" data-off={call.muted || !!call.listener || undefined} aria-pressed={call.muted} disabled={!!call.listener}
          aria-label={call.listener ? "Listen only: your mic isn't heard here" : call.muted ? 'Unmute' : 'Mute'} onClick={() => { void voice.setMuted(!call.muted); }}>
          {call.muted || call.listener ? <MicOff size={22} aria-hidden="true" /> : <Mic size={22} aria-hidden="true" />}
        </button>
        {vstate.canCapture && (
          <button type="button" class="mcall-dock-btn" data-off={!camLive || undefined} data-paused={cam.paused || undefined} aria-pressed={camLive} disabled={!canSend}
            aria-label={cam.paused ? 'Camera paused until the app is open again (turn off)' : camLive ? 'Turn camera off' : 'Turn camera on'}
            onClick={() => { void video?.setCamera(!camLive); }}>
            {camLive ? <Video size={22} aria-hidden="true" /> : <VideoOff size={22} aria-hidden="true" />}
          </button>
        )}
        {cam.on && <FlipButton />}
        <button type="button" class="mcall-dock-btn" aria-label="More options" onClick={() => setMore(true)}><MoreHorizontal size={22} aria-hidden="true" /></button>
        <button type="button" class="mcall-dock-btn mcall-leave" aria-label="Leave call" onClick={() => { closeCall(); void voice.leave(); }}>
          <PhoneOff size={24} aria-hidden="true" />
        </button>
      </div>
      {more && <MoreSheet voice={voice} call={call} onChat={onChat} onPeople={() => { setMore(false); setPeople(true); }} onClose={() => setMore(false)} />}
      {people && <VoicePanel voice={voice} call={call} serverName={snap.callServerName} avatarFor={avatarFor} onClose={() => setPeople(false)} />}
    </main>
  );
}

function MTile({ tile, cls, avatar, label, ariaLabel, onClick, onSize, canvasRef }: {
  tile: CallTileInfo; cls: string; avatar?: string; label: string; ariaLabel?: string; onClick?: () => void;
  onSize: (key: string, w: number, h: number) => void; canvasRef: (el: HTMLCanvasElement | null) => void;
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
  const notice = useTrackNotice(getVideoController(), tile.track?.trackId);
  const body = (
    <>
      {tile.track ? (
        <canvas class="mcall-video" ref={canvasRef} data-fit={tile.screen ? 'contain' : 'cover'} />
      ) : (
        <span class="mcall-avatar" data-speaking={tile.speaking || undefined}><Avatar nick={tile.name} url={avatar} size={52} /></span>
      )}
      {tile.track && notice && <span class="video-notice" role="status">{notice}</span>}
      <span class="mcall-tag">
        {tile.screen && <span class="voice-live" aria-hidden="true">LIVE</span>}
        {label}
        {tile.muted && <MicOff size={12} class="mcall-muted" aria-label="muted" />}
      </span>
    </>
  );
  const attrs = { class: `mcall-t ${cls}`, 'data-speaking': tile.speaking || undefined, 'data-screen': tile.screen || undefined };
  return onClick
    ? <button type="button" ref={setEl} {...attrs} aria-label={ariaLabel ?? label} onClick={onClick}>{body}</button>
    : <div ref={setEl} {...attrs} aria-label={label}>{body}</div>;
}

// Your own video, a small picture in a corner: drag it to another one.
function SelfPip({ tile, corner, onCorner, avatar, facing, canvasRef }: {
  tile: CallTileInfo; corner: Corner; onCorner: (c: Corner) => void; avatar?: string; facing?: string;
  canvasRef: (el: HTMLCanvasElement | null) => void;
}) {
  const [drag, setDrag] = useState<{ dx: number; dy: number } | null>(null);
  const start = useRef<{ x: number; y: number; id: number } | null>(null);
  const el = useRef<HTMLDivElement>(null);
  const label = tile.selfCamera ? `you · ${facing === 'back' ? 'back' : 'front'}` : 'you';
  return (
    <div ref={el} class="mcall-pip" data-corner={corner} aria-label="Your video"
      style={drag ? { transform: `translate(${drag.dx}px, ${drag.dy}px)`, transition: 'none' } : undefined}
      onPointerDown={(e) => { start.current = { x: e.clientX, y: e.clientY, id: e.pointerId }; (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId); }}
      onPointerMove={(e) => { const s = start.current; if (s && s.id === e.pointerId) setDrag({ dx: e.clientX - s.x, dy: e.clientY - s.y }); }}
      onPointerUp={() => {
        const s = start.current;
        start.current = null;
        const box = el.current?.getBoundingClientRect();
        const stage = el.current?.parentElement?.getBoundingClientRect();
        if (s && drag && box && stage) {
          const cx = box.left + box.width / 2;
          const cy = box.top + box.height / 2;
          onCorner(`${cy < stage.top + stage.height / 2 ? 't' : 'b'}${cx < stage.left + stage.width / 2 ? 'l' : 'r'}` as Corner);
        }
        setDrag(null);
      }}
      onPointerCancel={() => { start.current = null; setDrag(null); }}>
      {tile.selfCamera
        ? <canvas class="mcall-video" ref={canvasRef} data-fit="cover" data-mirror={facing !== 'back' || undefined} />
        : <Avatar nick={tile.name} url={avatar} size={40} />}
      <span class="mcall-pip-label">{label}</span>
    </div>
  );
}

// Flip: the next camera (front ↔ back), while the camera is on.
function FlipButton() {
  const { video, snap } = useVideo();
  const [cams, setCams] = useState<VideoCamera[]>([]);
  useEffect(() => {
    if (!video) return;
    let alive = true;
    void video.cameras().then((c) => { if (alive) setCams(c.filter((x) => !x.unavailable)); }, () => {});
    return () => { alive = false; };
  }, [video]);
  if (!video || cams.length < 2) return null;
  const cam = snap.state.camera;
  const cur = cams.findIndex((c) => c.id === cam.id);
  const next = cams[((cur >= 0 ? cur : Math.max(0, cams.findIndex((c) => c.default))) + 1) % cams.length];
  return (
    <button type="button" class="mcall-dock-btn" aria-label={`Switch to the ${next.facing === 'back' ? 'back' : next.facing === 'front' ? 'front' : 'next'} camera`}
      onClick={() => { void video.setCamera(true, next.id); }}>
      <SwitchCamera size={22} aria-hidden="true" />
    </button>
  );
}

function MoreSheet({ voice, call, onChat, onPeople, onClose }: {
  voice: VoiceController; call: VoiceState; onChat?: () => void; onPeople: () => void; onClose: () => void;
}) {
  const headset = call.route === 'bluetooth' || call.route === 'headphones';
  const output = headset ? (call.route === 'bluetooth' ? 'Bluetooth' : 'Headphones') : call.speaker ? 'Speaker' : 'Earpiece';
  return (
    <BottomSheet label="Call options" onClose={onClose} actions={[]} header={null}>
      <div class="mcall-more">
        {onChat && (
          <button type="button" class="mcall-opt" onClick={() => { onClose(); onChat(); }}>
            <MessageSquare size={20} aria-hidden="true" /><span class="mcall-opt-label">Chat in {call.roomName || call.room}</span>
          </button>
        )}
        <button type="button" class="mcall-opt" disabled={headset} onClick={() => { void voice.setSpeaker(!call.speaker); }}>
          {call.speaker ? <Volume2 size={20} aria-hidden="true" /> : headset ? <Headphones size={20} aria-hidden="true" /> : <Ear size={20} aria-hidden="true" />}
          <span class="mcall-opt-label">Audio output</span><span class="mcall-opt-value">{output}</span>
        </button>
        <button type="button" class="mcall-opt" aria-pressed={call.deafened} onClick={() => { void voice.setDeafened(!call.deafened); }}>
          {call.deafened ? <HeadphoneOff size={20} aria-hidden="true" /> : <Headphones size={20} aria-hidden="true" />}
          <span class="mcall-opt-label">Deafen</span><span class="mcall-opt-value" data-on={call.deafened || undefined}>{call.deafened ? 'On' : 'Off'}</span>
        </button>
        <button type="button" class="mcall-opt" onClick={onPeople}>
          <Users size={20} aria-hidden="true" /><span class="mcall-opt-label">People and volume</span>
        </button>
        <button type="button" class="mcall-opt" disabled>
          <MonitorUp size={20} aria-hidden="true" /><span class="mcall-opt-label">Share screen</span><span class="mcall-opt-value">soon on phones</span>
        </button>
        <button type="button" class="mcall-opt mcall-opt-close" onClick={onClose}>Close</button>
      </div>
    </BottomSheet>
  );
}

/** Minimized: at the bottom of every screen while you're in a call. */
export function MobileMiniBar() {
  const { voice, snap } = useVoice();
  const { snap: vsnap } = useVideo();
  const call = snap.call;
  if (!voice || !call.host || call.status === 'idle') return null;
  const where = call.roomName || call.room;
  if (call.status === 'error') {
    const retryable = call.errorKind === 'token' || call.errorKind === 'unreachable' || call.errorKind === 'dropped';
    return (
      <div class="mcall-mini" data-state="error" role="alert">
        <span class="mcall-mini-text">
          <span class="mcall-mini-title">{call.errorKind === 'kicked' ? 'Disconnected from voice' : 'Voice failed'}</span>
          <span class="mcall-mini-sub">{call.error}</span>
        </span>
        {retryable && call.room && (
          <button type="button" class="mcall-icon" aria-label="Try again"
            onClick={() => { void voice.join(call.host, { id: call.room, name: where }, snap.callServerName); }}>
            <RotateCw size={20} aria-hidden="true" />
          </button>
        )}
        <button type="button" class="mcall-icon" aria-label="Dismiss" onClick={() => { void voice.dismissError(); }}><X size={20} aria-hidden="true" /></button>
      </div>
    );
  }
  const connecting = call.status === 'connecting';
  const sharer = vsnap.state.tracks.find((t) => t.kind === 'screen' && !t.self)?.name;
  const rtt = call.rttMs > 0 ? `${Math.round(call.rttMs)} ms` : '';
  const sub = connecting ? 'Connecting…'
    : call.interrupted ? 'Paused while another call has the audio'
      : [sharer ? `${sharer} is sharing` : '', rtt].filter(Boolean).join(' · ') || 'Connected';
  return (
    <div class="mcall-mini" data-state={connecting ? 'connecting' : call.interrupted ? 'paused' : 'connected'}>
      <button type="button" class="mcall-mini-open" aria-label={`Open the call in ${where}`} onClick={openCall}>
        <span class="mcall-dot" aria-hidden="true" />
        <span class="mcall-mini-text">
          <span class="mcall-mini-title">{where} · {call.participants.length}</span>
          <span class="mcall-mini-sub">{sub}</span>
        </span>
      </button>
      <button type="button" class="mcall-icon mcall-icon-box" data-off={call.muted || undefined} aria-pressed={call.muted}
        aria-label={call.muted ? 'Unmute' : 'Mute'} onClick={() => { void voice.setMuted(!call.muted); }}>
        {call.muted ? <MicOff size={20} aria-hidden="true" /> : <Mic size={20} aria-hidden="true" />}
      </button>
      <button type="button" class="mcall-icon mcall-icon-box" aria-label="Open call" onClick={openCall}><ChevronUp size={20} aria-hidden="true" /></button>
      <button type="button" class="mcall-icon mcall-icon-box mcall-leave" aria-label="Leave call" onClick={() => { closeCall(); void voice.leave(); }}>
        <PhoneOff size={20} aria-hidden="true" />
      </button>
    </div>
  );
}
