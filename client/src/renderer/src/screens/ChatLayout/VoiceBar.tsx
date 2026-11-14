import { Headphones, HeadphoneOff, Mic, MicOff, PhoneOff, RotateCw, Settings, Signal, SignalLow, SignalMedium, X } from 'lucide-preact';
import { useVoice, type VoiceQuality } from '../../modules/voice';
import { openUserSettings } from '../../modules/ui/open-settings';
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
  return (
    <div class="voice-bar" data-state={call.status} aria-label="Voice connection">
      <div class="voice-bar-head">
        <span class="voice-bar-quality" data-quality={connecting ? 'connecting' : call.quality}
          title={connecting ? 'Connecting…' : `${QUALITY_LABEL[call.quality]}${rtt ? ` · ${rtt}` : ''}${call.lossPercent >= 1 ? ` · ${call.lossPercent.toFixed(0)}% loss` : ''}`}>
          <QualityIcon size={15} aria-hidden="true" />
          <span class="voice-bar-status">{connecting ? 'Connecting…' : 'Voice connected'}</span>
        </span>
        {!connecting && rtt && <span class="voice-bar-rtt" aria-label={`Round trip ${rtt}`}>{rtt}</span>}
        <button type="button" class="voice-bar-btn voice-bar-leave" aria-label="Disconnect" title="Disconnect" onClick={() => { void voice.leave(); }}>
          <PhoneOff size={15} aria-hidden="true" />
        </button>
      </div>
      <div class="voice-bar-where" title={where}>{where}</div>
      <div class="voice-bar-controls">
        {listener ? (
          <button
            type="button"
            class="voice-bar-btn"
            data-on
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
            data-on={call.muted || undefined}
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
          data-on={call.deafened || undefined}
          aria-label={call.deafened ? 'Undeafen' : 'Deafen'}
          title={call.deafened ? 'Undeafen' : 'Deafen'}
          onClick={() => { void voice.setDeafened(!call.deafened); }}
        >
          {call.deafened ? <HeadphoneOff size={16} aria-hidden="true" /> : <Headphones size={16} aria-hidden="true" />}
        </button>
        {listener ? (
          <span class="voice-bar-mode voice-bar-listen" title="You joined as a listener">Listen only</span>
        ) : (
          <span class="voice-bar-mode" title={call.pushToTalk ? 'Push to talk' : 'Voice activity'}>
            {call.pushToTalk ? 'PTT' : 'VAD'}
            <span class="voice-bar-tx" data-on={call.transmitting && !call.muted && !call.deafened ? true : undefined} aria-hidden="true" />
          </span>
        )}
        <button type="button" class="voice-bar-btn" aria-label="Voice settings" title="Voice settings" onClick={() => openUserSettings('voice')}>
          <Settings size={16} aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}
