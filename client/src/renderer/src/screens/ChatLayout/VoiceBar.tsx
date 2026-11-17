import { Headphones, HeadphoneOff, Mic, MicOff, PhoneOff, RotateCw, Signal, SignalLow, SignalMedium, SlidersHorizontal, X } from 'lucide-preact';
import { useVideo } from '../../modules/video';
import { useVoice, type VoiceQuality } from '../../modules/voice';
import { openUserSettings } from '../../modules/ui/open-settings';
import { isMobile } from '../../shared/window-controls';
import { HoldToTalk } from './MobileVoice';
import { CallVideoButtons } from './CallControls';
import './VoiceSection.css';

const QUALITY_LABEL: Record<VoiceQuality, string> = {
  good: 'Good connection', ok: 'Fair connection', poor: 'Poor connection', unknown: 'Measuring connection…',
};

// The "voice connected" bar at the foot of the channel list (whichever
// server is open): the room and server, connection quality and RTT, and
// mute, deafen, settings and disconnect. Errors show here too, with a
// retry where one could help.
export function VoiceBar() {
  const { voice, snap } = useVoice();
  const { video, snap: vsnap } = useVideo();
  const call = snap.call;
  if (!voice || !call.host || call.status === 'idle') return null;

  const where = [call.roomName || call.room, snap.callServerName].filter(Boolean).join(' / ');

  if (call.status === 'error' && call.errorKind === 'kicked') {
    // Put out of the room (it was deleted): say so, nothing to retry.
    return (
      <div class="voice-bar voice-bar-notice" role="status">
        <div class="voice-bar-head">
          <span class="voice-bar-status">Disconnected from voice</span>
          <span class="voice-bar-actions">
            <button type="button" class="voice-bar-btn" aria-label="Dismiss" title="Dismiss" onClick={() => { void voice.dismissError(); }}>
              <X size={15} aria-hidden="true" />
            </button>
          </span>
        </div>
        <div class="voice-bar-error-text">{call.error}</div>
        {snap.callServerName && <div class="voice-bar-where">{snap.callServerName}</div>}
      </div>
    );
  }

  if (call.status === 'error') {
    const retryable = call.errorKind === 'token' || call.errorKind === 'unreachable' || call.errorKind === 'dropped';
    return (
      <div class="voice-bar voice-bar-error" role="alert">
        <div class="voice-bar-head">
          <span class="voice-bar-status">Voice failed</span>
          <span class="voice-bar-actions">
            {retryable && call.room && (
              <button type="button" class="voice-bar-btn" aria-label="Try again" title="Try again"
                onClick={() => { void voice.join(call.host, { id: call.room, name: call.roomName || call.room }, snap.callServerName); }}>
                <RotateCw size={15} aria-hidden="true" />
              </button>
            )}
            <button type="button" class="voice-bar-btn" aria-label="Dismiss" title="Dismiss" onClick={() => { void voice.dismissError(); }}>
              <X size={15} aria-hidden="true" />
            </button>
          </span>
        </div>
        <div class="voice-bar-error-text">{call.error}</div>
        {where && <div class="voice-bar-where">{where}</div>}
      </div>
    );
  }

  const connecting = call.status === 'connecting';
  // In below the room's speak role: nobody hears the mic.
  const listener = !!call.listener && !connecting;
  const QualityIcon = call.quality === 'poor' ? SignalLow : call.quality === 'ok' ? SignalMedium : Signal;
  const rtt = call.rttMs > 0 ? `${Math.round(call.rttMs)} ms` : '';
  const quality = connecting ? 'Connecting…' : `${QUALITY_LABEL[call.quality]}${rtt ? ` · ${rtt}` : ''}${call.lossPercent >= 1 ? ` · ${call.lossPercent.toFixed(0)}% loss` : ''}`;
  // "Connected · 38 ms / General / Server" opens the call (where the
  // server has video).
  const canOpen = !connecting && !!video && vsnap.state.available;
  const openCall = (): void => { if (canOpen) video!.setOpen(true); };
  return (
    <div class="voice-bar voice-panel" data-state={call.status} aria-label="Voice connection">
      <div class="voice-bar-head">
        <span class="voice-bar-quality" data-quality={connecting ? 'connecting' : call.quality} title={quality}>
          <QualityIcon size={15} aria-hidden="true" />
        </span>
        <button type="button" class="voice-panel-where" onClick={openCall} disabled={!canOpen}
          aria-label={canOpen ? `Open the call in ${where}` : `Voice: ${where}`} title={canOpen ? 'Open the call' : quality}>
          <span class="voice-panel-status" data-quality={connecting ? 'connecting' : call.quality}>
            {connecting ? 'Connecting…' : `Connected${rtt ? ` · ${rtt}` : ''}`}
          </span>
          <span class="voice-bar-where">{where}</span>
        </button>
        <button type="button" class="voice-bar-btn voice-panel-leave" aria-label="Leave call" title="Leave" onClick={() => { void voice.leave(); }}>
          <PhoneOff size={14} aria-hidden="true" />
        </button>
      </div>
      <div class="voice-panel-controls">
        {listener ? (
          <button
            type="button"
            class="voice-bar-btn"
            data-off
            disabled
            aria-label="Listen only: your mic isn't heard in this channel"
            title="Listen only: talking in this channel needs a higher role"
          >
            <MicOff size={16} aria-hidden="true" />
          </button>
        ) : (
          <button
            type="button"
            class="voice-bar-btn"
            aria-pressed={call.muted}
            data-off={call.muted || undefined}
            aria-label={call.muted ? 'Unmute' : 'Mute'}
            title={call.muted ? 'Unmute' : 'Mute'}
            onClick={() => { void voice.setMuted(!call.muted); }}
          >
            {call.muted ? <MicOff size={16} aria-hidden="true" /> : <Mic size={16} aria-hidden="true" />}
          </button>
        )}
        <button
          type="button"
          class="voice-bar-btn"
          aria-pressed={call.deafened}
          data-off={call.deafened || undefined}
          aria-label={call.deafened ? 'Undeafen' : 'Deafen'}
          title={call.deafened ? 'Undeafen' : 'Deafen'}
          onClick={() => { void voice.setDeafened(!call.deafened); }}
        >
          {call.deafened ? <HeadphoneOff size={16} aria-hidden="true" /> : <Headphones size={16} aria-hidden="true" />}
        </button>
        {!connecting && <CallVideoButtons withCallToggle={false} />}
        <button type="button" class="voice-bar-btn" aria-label="Voice settings" title="Voice settings" onClick={() => openUserSettings('voice')}>
          <SlidersHorizontal size={16} aria-hidden="true" />
        </button>
      </div>
      {/* A tablet in the wide layout has no key to hold: the button. */}
      {isMobile() && call.pushToTalk && !listener && !connecting && <HoldToTalk voice={voice} call={call} compact />}
    </div>
  );
}
