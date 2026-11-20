import type { ComponentChildren, JSX } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { Button, EmptyState, ListRow, Segmented } from '@boson/shared';
import { Bluetooth, Ear, Headphones, HeadphoneOff, Mic, MicOff, PhoneOff, Signal, SignalLow, SignalMedium, Volume2 } from 'lucide-preact';
import {
  getVoiceSettings, onVoiceSettingsChange, type VoiceController, type VoiceParticipant, type VoiceState,
} from '../../modules/voice';
import { Avatar } from '../../shared/Avatar/Avatar';
import { BottomSheet } from './BottomSheet';
import './MobileVoice.css';

// The phone's voice pieces still in use: the people sheet (VoicePanel:
// who's in, each person's volume, mute, deafen, speaker or earpiece, open
// mic or push to talk) and the hold-to-talk button. The call screen and
// the minimized bar are MobileCall.tsx.

// A call control with its word under it: a 44px Button and a caption.
function CallControl({ label, children }: { label: string; children: ComponentChildren }) {
  return (
    <div class="mvoice-ctl">
      {children}
      <span class="mvoice-ctl-label" aria-hidden="true">{label}</span>
    </div>
  );
}

function MuteButton({ voice, call, listener }: { voice: VoiceController; call: VoiceState; listener: boolean }) {
  const muted = call.muted || call.deafened;
  const label = listener ? "Listen only: talking here needs a higher role" : muted ? 'Unmute' : 'Mute';
  return (
    <CallControl label={listener ? 'Listening' : muted ? 'Muted' : 'Mute'}>
      <Button variant="secondary" size="lg" pressed={muted} aria-label={label} disabled={listener}
        onClick={() => { void voice.setMuted(!muted); }}
        icon={muted || listener ? <MicOff aria-hidden="true" /> : <Mic aria-hidden="true" />} />
    </CallControl>
  );
}

const ROUTE_LABEL: Record<string, string> = {
  speaker: 'Speaker', earpiece: 'Earpiece', headphones: 'Headphones', bluetooth: 'Bluetooth', other: 'Audio',
};

export function VoicePanel({ voice, call, serverName, avatarFor, onClose }: {
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
        {call.participants.length === 0 && <li class="mvoice-empty"><EmptyState>{connecting ? 'Joining…' : 'Nobody here yet.'}</EmptyState></li>}
      </ul>

      <div class="mvoice-controls">
        <MuteButton voice={voice} call={call} listener={listener} />
        <CallControl label={call.deafened ? 'Deafened' : 'Deafen'}>
          <Button variant="secondary" size="lg" pressed={call.deafened}
            aria-label={call.deafened ? 'Undeafen' : 'Deafen'} onClick={() => { void voice.setDeafened(!call.deafened); }}
            icon={call.deafened ? <HeadphoneOff aria-hidden="true" /> : <Headphones aria-hidden="true" />} />
        </CallControl>
        <CallControl label={routeLabel}>
          <Button variant="secondary" size="lg" pressed={call.speaker} disabled={headset}
            aria-label={headset ? `Playing through ${routeLabel}` : call.speaker ? 'Switch to the earpiece' : 'Switch to the speaker'}
            onClick={() => { void voice.setSpeaker(!call.speaker); }} icon={<RouteIcon aria-hidden="true" />} />
        </CallControl>
        <CallControl label="Leave">
          <Button variant="danger" size="lg" aria-label="Leave voice"
            onClick={() => { onClose(); void voice.leave(); }} icon={<PhoneOff aria-hidden="true" />} />
        </CallControl>
      </div>

      {!listener && (
        <Segmented size="lg" class="mvoice-mode" label="When you transmit" value={mode}
          options={[{ id: 'vad', label: 'Open mic' }, { id: 'ptt', label: 'Push to talk' }]}
          onChange={(m) => voice.setInputMode(m)} />
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
    <ListRow
      as="li"
      size="lg"
      class="mvoice-person"
      rowProps={{ 'data-speaking': p.speaking || undefined, ...(p.self || !p.userId ? { 'aria-label': `${name}${state ? `: ${state}` : ''}` } : {}) } as JSX.HTMLAttributes<HTMLElement>}
      leading={<span class="mvoice-person-avatar" data-speaking={p.speaking || undefined}><Avatar nick={p.name} url={url} size={32} /></span>}
      title={name}
      titleTone={p.speaking ? 'success' : undefined}
      aside={(<>
        {!p.self && p.volume !== 100 && <span class="mvoice-person-vol">{p.volume}%</span>}
        {p.deafened ? <HeadphoneOff size={16} class="mvoice-person-flag" aria-hidden="true" />
          : p.listener ? <span class="mvoice-person-listening">listening</span>
          : p.muted ? <MicOff size={16} class="mvoice-person-flag" aria-hidden="true" /> : null}
      </>)}
      onClick={p.self || !p.userId ? undefined : onToggle}
      ariaLabel={`${name}${state ? `: ${state}` : ''}. Volume`}
      mainProps={{ 'aria-expanded': open }}
    >
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
    </ListRow>
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
    <Button
      variant={on ? 'success' : 'secondary'}
      size={compact ? 'lg' : 'xl'}
      fullWidth
      class={`mvoice-ptt${compact ? ' mvoice-ptt-compact' : ''}`}
      data-held={held || undefined}
      data-on={on || undefined}
      pressed={on ? undefined : held}
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
      icon={<Mic aria-hidden="true" />}
    >
      {held ? (call.muted || call.deafened ? 'Muted' : 'Talking…') : 'Hold to talk'}
    </Button>
  );
}
