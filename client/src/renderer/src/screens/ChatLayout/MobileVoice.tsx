import { useEffect, useState } from 'preact/hooks';
import { Bluetooth, Ear, Headphones, HeadphoneOff, Mic, MicOff, PhoneOff, RotateCw, Signal, SignalLow, SignalMedium, Volume2, X, LayoutGrid, MessageSquare, Users, MonitorUp, MonitorX, SwitchCamera, Video, VideoOff } from 'lucide-preact';
import {
  getVoiceSettings, onVoiceSettingsChange, useVoice, type VoiceController, type VoiceParticipant, type VoiceState,
} from '../../modules/voice';
import { Avatar } from '../../shared/Avatar/Avatar';
import { BottomSheet } from './BottomSheet';
import { useVideo, type VideoCamera } from '../../modules/video';
import './MobileVoice.css';

// Voice on a phone (the narrow layout): the call bar at the top of the chat,
// there whichever channel or server is open, with the two things you reach
// for mid-call — mute and hang up — as big targets; a tap on it opens the
// call screen (VoicePanel): who's in, who's talking, mute, deafen,
// loudspeaker or earpiece, open mic or push to talk (a hold-to-talk
// button), and each person's volume.
//
// With the call view open the bar is the call's only one (CallView has no
// header on a phone): mute, camera, flip camera, screen (where the app can
// share it), back to the chat, and hang up.
export function MobileCallBar({ avatarFor }: { avatarFor?: (nick: string) => string | undefined }) {
  const { voice, snap } = useVoice();
  const { snap: vsnap } = useVideo();
  const [open, setOpen] = useState(false);
  const call = snap.call;
  const live = !!voice && !!call.host && call.status !== 'idle';
  if (!voice || !live) return null;

  const where = call.roomName || call.room;
  if (call.status === 'error') {
    const retryable = call.errorKind === 'token' || call.errorKind === 'unreachable' || call.errorKind === 'dropped';
    return (
      <div class="mvoice-bar" data-state="error" role="alert">
        <span class="mvoice-dot" aria-hidden="true" />
        <div class="mvoice-bar-text">
          <span class="mvoice-bar-title">{call.errorKind === 'kicked' ? 'Disconnected from voice' : 'Voice failed'}</span>
          <span class="mvoice-bar-sub mvoice-bar-error">{call.error}</span>
        </div>
        {retryable && call.room && (
          <button type="button" class="mvoice-icon-btn" aria-label="Try again"
            onClick={() => { void voice.join(call.host, { id: call.room, name: where }, snap.callServerName); }}>
            <RotateCw size={20} aria-hidden="true" />
          </button>
        )}
        <button type="button" class="mvoice-icon-btn" aria-label="Dismiss" onClick={() => { void voice.dismissError(); }}>
          <X size={20} aria-hidden="true" />
        </button>
      </div>
    );
  }

  const connecting = call.status === 'connecting';
  const listener = !!call.listener && !connecting;
  const others = call.participants.filter((p) => !p.self);
  const inCallView = vsnap.open && vsnap.state.available && call.status === 'connected';
  const talking = call.participants.some((p) => p.speaking && !p.self);
  const sub = connecting ? 'Connecting…'
    : call.interrupted ? 'Paused while another call has the audio'
    : inCallView ? '' // the count shows as an icon: the room is for the controls (the RTT is in the panel)
    : `${call.participants.length} in call${call.rttMs > 0 ? ` · ${Math.round(call.rttMs)} ms` : ''}`;
  return (
    <>
      <div class="mvoice-bar" data-state={connecting ? 'connecting' : call.interrupted ? 'paused' : 'connected'} data-incall={inCallView || undefined}>
        <button type="button" class="mvoice-bar-open" aria-label={`Voice: ${where}. Open the call`} onClick={() => setOpen(true)}>
          <span class="mvoice-dot" data-talking={talking || undefined} aria-hidden="true" />
          <span class="mvoice-bar-text">
            <span class="mvoice-bar-title">{where}</span>
            {inCallView && !connecting && !call.interrupted
              ? <span class="mvoice-bar-sub mvoice-bar-count" aria-label={`${call.participants.length} in call`}><Users size={11} aria-hidden="true" />{call.participants.length}</span>
              : <span class="mvoice-bar-sub">{sub}</span>}
          </span>
          {others.length > 0 && !inCallView && (
            <span class="mvoice-bar-faces" aria-hidden="true">
              {others.slice(0, 3).map((p) => (
                <span key={p.sessionId} class="mvoice-face" data-speaking={p.speaking || undefined}>
                  <Avatar nick={p.name} url={avatarFor?.(p.name)} size={22} />
                </span>
              ))}
            </span>
          )}
        </button>
        <MuteButton voice={voice} call={call} listener={listener} small />
        {!connecting && (inCallView ? <MobileCallControls /> : <MobileVideoToggle />)}
        <button type="button" class="mvoice-icon-btn mvoice-leave" aria-label="Leave voice" onClick={() => { void voice.leave(); }}>
          <PhoneOff size={20} aria-hidden="true" />
        </button>
      </div>
      {open && <VoicePanel voice={voice} call={call} serverName={snap.callServerName} avatarFor={avatarFor} onClose={() => setOpen(false)} />}
    </>
  );
}

// The call view's controls on a phone: camera (on, off, or paused while the
// app was in the background), flip to the next camera, screen share where
// this build can, and back to the chat.
function MobileCallControls() {
  const { video, snap } = useVideo();
  const { snap: vs } = useVoice();
  const [cams, setCams] = useState<VideoCamera[]>([]);
  const st = snap.state;
  const cam = st.camera;
  const scr = st.screen;
  const camLive = cam.on || cam.starting || !!cam.paused;
  // The cameras, once it's on: two or more → a flip button.
  useEffect(() => {
    if (!video || !camLive || cams.length > 0) return;
    let alive = true;
    void video.cameras().then((c) => { if (alive) setCams(c.filter((x) => !x.unavailable)); }, () => {});
    return () => { alive = false; };
  }, [video, camLive, cams.length]);
  if (!video) return null;
  const canSend = st.canCapture && st.canPublish && !vs.call.listener;
  const camLabel = cam.paused ? 'Camera paused until the app is open again (turn off)'
    : cam.starting ? 'Starting camera… (cancel)' : cam.on ? 'Turn camera off' : 'Turn camera on';
  const flip = () => {
    const cur = cams.findIndex((c) => c.id === cam.id) >= 0 ? cams.findIndex((c) => c.id === cam.id) : cams.findIndex((c) => c.default);
    const next = cams[(Math.max(cur, 0) + 1) % cams.length];
    if (next) void video.setCamera(true, next.id);
  };
  return (
    <>
      {st.canCapture && (
        <button type="button" class="mvoice-icon-btn" aria-pressed={camLive} data-live={camLive || undefined}
          data-starting={cam.starting || undefined} data-paused={cam.paused || undefined} disabled={!canSend} aria-label={camLabel}
          onClick={() => { void video.setCamera(!camLive); }}>
          {camLive ? <Video size={20} aria-hidden="true" /> : <VideoOff size={20} aria-hidden="true" />}
        </button>
      )}
      {st.canCapture && cam.on && cams.length > 1 && (
        <button type="button" class="mvoice-icon-btn" aria-label="Switch camera" onClick={flip}>
          <SwitchCamera size={20} aria-hidden="true" />
        </button>
      )}
      {st.canCapture && st.canShareScreen && (
        <button type="button" class="mvoice-icon-btn" aria-pressed={scr.on} data-live={scr.on || scr.starting || undefined} disabled={!canSend}
          aria-label={scr.on || scr.starting ? 'Stop sharing your screen' : 'Share your screen'}
          onClick={() => { void video.setScreen(!(scr.on || scr.starting), ''); }}>
          {scr.on || scr.starting ? <MonitorX size={20} aria-hidden="true" /> : <MonitorUp size={20} aria-hidden="true" />}
        </button>
      )}
      <button type="button" class="mvoice-icon-btn" aria-label="Back to chat" onClick={() => video.setOpen(false)}>
        <MessageSquare size={20} aria-hidden="true" />
      </button>
    </>
  );
}

// Show the call's video (or go back to the chat): on servers with video.
function MobileVideoToggle() {
  const { video, snap } = useVideo();
  if (!video || !snap.state.available) return null;
  return (
    <button type="button" class="mvoice-icon-btn" aria-pressed={snap.open} data-live={snap.open || undefined}
      aria-label={snap.open ? 'Back to chat' : 'Show the call'} onClick={() => video.setOpen(!snap.open)}>
      <LayoutGrid size={20} aria-hidden="true" />
    </button>
  );
}

function MuteButton({ voice, call, listener, small }: { voice: VoiceController; call: VoiceState; listener: boolean; small?: boolean }) {
  const muted = call.muted || call.deafened;
  const label = listener ? "Listen only: talking here needs a higher role" : muted ? 'Unmute' : 'Mute';
  return (
    <button
      type="button"
      class={small ? 'mvoice-icon-btn' : 'mvoice-round'}
      data-on={muted || listener || undefined}
      aria-pressed={muted}
      aria-label={label}
      disabled={listener}
      onClick={() => { void voice.setMuted(!muted); }}
    >
      {muted || listener ? <MicOff size={small ? 20 : 26} aria-hidden="true" /> : <Mic size={small ? 20 : 26} aria-hidden="true" />}
      {!small && <span class="mvoice-round-label">{listener ? 'Listening' : muted ? 'Muted' : 'Mute'}</span>}
    </button>
  );
}

const ROUTE_LABEL: Record<string, string> = {
  speaker: 'Speaker', earpiece: 'Earpiece', headphones: 'Headphones', bluetooth: 'Bluetooth', other: 'Audio',
};

function VoicePanel({ voice, call, serverName, avatarFor, onClose }: {
  voice: VoiceController;
  call: VoiceState;
  serverName: string;
  avatarFor?: (nick: string) => string | undefined;
  onClose: () => void;
}) {
  const [mode, setMode] = useState(() => getVoiceSettings().mode);
  useEffect(() => onVoiceSettingsChange((s) => setMode(s.mode)), []);
  const [volumeFor, setVolumeFor] = useState<string | null>(null);
  const connecting = call.status === 'connecting';
  const listener = !!call.listener && !connecting;
  const QualityIcon = call.quality === 'poor' ? SignalLow : call.quality === 'ok' ? SignalMedium : Signal;
  // A headset has the sound: the speaker switch would do nothing.
  const headset = call.route === 'bluetooth' || call.route === 'headphones';
  const RouteIcon = call.route === 'bluetooth' ? Bluetooth : call.route === 'headphones' ? Headphones : call.speaker ? Volume2 : Ear;
  const routeLabel = call.route && headset ? ROUTE_LABEL[call.route] : call.speaker ? 'Speaker' : 'Earpiece';

  return (
    <BottomSheet
      label={`Voice call: ${call.roomName || call.room}`}
      onClose={onClose}
      actions={[]}
      header={(
        <div class="mvoice-panel-head">
          <div class="mvoice-panel-title">{call.roomName || call.room}</div>
          <div class="mvoice-panel-sub" data-quality={connecting ? 'connecting' : call.quality}>
            <QualityIcon size={14} aria-hidden="true" />
            <span>
              {connecting ? 'Connecting…' : call.interrupted ? 'Paused while another call has the audio' : 'Voice connected'}
              {serverName ? ` · ${serverName}` : ''}
              {!connecting && call.rttMs > 0 ? ` · ${Math.round(call.rttMs)} ms` : ''}
            </span>
          </div>
        </div>
      )}
    >
      <ul class="mvoice-people" aria-label="In this voice channel">
        {call.participants.map((p) => (
          <Person
            key={p.sessionId}
            p={p}
            url={avatarFor?.(p.name)}
            open={volumeFor === p.userId && !p.self}
            onToggle={() => setVolumeFor(volumeFor === p.userId ? null : p.userId)}
            voice={voice}
          />
        ))}
        {call.participants.length === 0 && <li class="mvoice-empty">{connecting ? 'Joining…' : 'Nobody here yet.'}</li>}
      </ul>

      <div class="mvoice-controls">
        <MuteButton voice={voice} call={call} listener={listener} />
        <button type="button" class="mvoice-round" data-on={call.deafened || undefined} aria-pressed={call.deafened}
          aria-label={call.deafened ? 'Undeafen' : 'Deafen'} onClick={() => { void voice.setDeafened(!call.deafened); }}>
          {call.deafened ? <HeadphoneOff size={26} aria-hidden="true" /> : <Headphones size={26} aria-hidden="true" />}
          <span class="mvoice-round-label">{call.deafened ? 'Deafened' : 'Deafen'}</span>
        </button>
        <button type="button" class="mvoice-round" aria-pressed={call.speaker} disabled={headset}
          aria-label={headset ? `Playing through ${routeLabel}` : call.speaker ? 'Switch to the earpiece' : 'Switch to the speaker'}
          onClick={() => { void voice.setSpeaker(!call.speaker); }}>
          <RouteIcon size={26} aria-hidden="true" />
          <span class="mvoice-round-label">{routeLabel}</span>
        </button>
        <button type="button" class="mvoice-round mvoice-round-leave" aria-label="Leave voice"
          onClick={() => { onClose(); void voice.leave(); }}>
          <PhoneOff size={26} aria-hidden="true" />
          <span class="mvoice-round-label">Leave</span>
        </button>
      </div>

      {!listener && (
        <div class="mvoice-mode" role="radiogroup" aria-label="When you transmit">
          <button type="button" role="radio" aria-checked={mode === 'vad'} class="mvoice-mode-opt"
            onClick={() => voice.setInputMode('vad')}>Open mic</button>
          <button type="button" role="radio" aria-checked={mode === 'ptt'} class="mvoice-mode-opt"
            onClick={() => voice.setInputMode('ptt')}>Push to talk</button>
        </div>
      )}
      {!listener && mode === 'ptt' && <HoldToTalk voice={voice} call={call} />}
    </BottomSheet>
  );
}

function Person({ p, url, open, onToggle, voice }: {
  p: VoiceParticipant;
  url?: string;
  open: boolean;
  onToggle: () => void;
  voice: VoiceController;
}) {
  const [volume, setVolume] = useState(() => voice.userVolume(p.userId));
  const state = [p.speaking ? 'speaking' : '', p.listener ? 'listening' : p.muted ? 'muted' : '', p.deafened ? 'deafened' : ''].filter(Boolean).join(', ');
  const name = `${p.name}${p.self ? ' (you)' : ''}`;
  return (
    <li class="mvoice-person" data-speaking={p.speaking || undefined}>
      <button type="button" class="mvoice-person-row" disabled={p.self || !p.userId} aria-expanded={p.self ? undefined : open}
        aria-label={`${name}${state ? `: ${state}` : ''}${p.self ? '' : '. Volume'}`} onClick={onToggle}>
        <span class="mvoice-person-avatar" data-speaking={p.speaking || undefined}>
          <Avatar nick={p.name} url={url} size={32} />
        </span>
        <span class="mvoice-person-name">{name}</span>
        {!p.self && p.volume !== 100 && <span class="mvoice-person-vol">{p.volume}%</span>}
        {p.deafened ? <HeadphoneOff size={16} class="mvoice-person-flag" aria-hidden="true" />
          : p.listener ? <span class="mvoice-person-listening">listening</span>
          : p.muted ? <MicOff size={16} class="mvoice-person-flag" aria-hidden="true" /> : null}
      </button>
      {open && (
        <div class="mvoice-person-volume">
          <input
            type="range"
            class="voice-range"
            min={0}
            max={200}
            step={5}
            value={volume}
            aria-label={`Volume for ${p.name}`}
            onInput={(e) => {
              const v = Number((e.target as HTMLInputElement).value);
              setVolume(v);
              voice.setUserVolume(p.userId, v);
            }}
          />
          <span class="mvoice-person-vol">{volume}%</span>
        </div>
      )}
    </li>
  );
}

// Push to talk on a touch screen: hold the button. The pointer is captured
// so a finger drifting off it keeps talking until it lifts; the sheet's
// swipe-to-close never sees the press. Also in the sidebar's voice bar on
// a tablet's wide layout (VoiceBar).
export function HoldToTalk({ voice, call, compact }: { voice: VoiceController; call: VoiceState; compact?: boolean }) {
  const [held, setHeld] = useState(false);
  const up = (): void => {
    setHeld(false);
    voice.holdToTalk(false);
  };
  useEffect(() => () => voice.holdToTalk(false), [voice]);
  const on = held && call.transmitting && !call.muted && !call.deafened;
  return (
    <button
      type="button"
      class={`mvoice-ptt${compact ? ' mvoice-ptt-compact' : ''}`}
      data-held={held || undefined}
      data-on={on || undefined}
      aria-pressed={held}
      aria-label="Hold to talk"
      onPointerDown={(e) => {
        e.stopPropagation();
        (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
        setHeld(true);
        voice.holdToTalk(true);
      }}
      onPointerUp={up}
      onPointerCancel={up}
      onLostPointerCapture={up}
      onContextMenu={(e) => e.preventDefault()}
    >
      <Mic size={22} aria-hidden="true" />
      {held ? (call.muted || call.deafened ? 'Muted' : 'Talking…') : 'Hold to talk'}
    </button>
  );
}
