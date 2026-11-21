import { useEffect } from 'preact/hooks';
import { createPortal } from 'preact/compat';
import { Mic, Phone, PhoneOff } from 'lucide-preact';
import { Avatar } from '../../shared/Avatar/Avatar';
import { useNarrow } from '../../shared/narrow';
import { useFriends, type CallInfo, type OutgoingCall } from '../../modules/friends';
import { startRing, stopRing } from './ring';
import { isMobile } from '../../shared/window-controls';
import { incomingCallStyle } from '../../modules/ui/notifications.store';
import { useNotificationSettings } from '../../modules/notifications/use-settings';
import { useRingExpanded } from '../Notifications/ring-ui';
import './CallOverlays.css';

// Private calls' own screens, over whatever is showing: "Calling mira…"
// (Cancel), the incoming call when it shows full screen (Decline, Voice
// only, Accept; "Incoming calls: Full screen", phones' default, or a banner
// that was tapped) and the friends toasts. As a banner it's one of the
// in-app notifications (Notifications/Toasts). The call itself is the
// app's usual call view.
export function CallOverlays() {
  const { friends, snap } = useFriends();
  const narrow = useNarrow();
  const settings = useNotificationSettings();
  const ringing = snap.ringing[0] ?? null;
  const expanded = useRingExpanded(ringing?.id ?? null);
  const fullScreen = expanded || incomingCallStyle(narrow || isMobile(), settings) === 'full';
  useEffect(() => {
    if (ringing) startRing();
    else stopRing();
    return () => stopRing();
  }, [ringing?.id]);
  if (!friends) return null;
  return createPortal(
    <>
      {snap.calling && <Outgoing out={snap.calling} phone={narrow} onCancel={() => { void friends.cancelCall(); }} />}
      {ringing && !snap.calling && fullScreen && (
        <Incoming
          key={ringing.id}
          call={ringing}
          phone={narrow || isMobile()}
          onDecline={() => { void friends.decline(ringing.id); }}
          onVoice={() => { void friends.accept(ringing.id, false); }}
          onAccept={() => { void friends.accept(ringing.id, ringing.video); }}
        />
      )}
      {snap.toast && (
        <div key={snap.toast.id} role="status" class={`call-toast${narrow ? ' call-toast-phone' : ''}`}>{snap.toast.text}</div>
      )}
    </>,
    document.body,
  );
}

function outcomeText(out: OutgoingCall): string {
  const name = out.peer.username;
  switch (out.status) {
    case 'declined': return `${name} is busy`;
    case 'missed': return `${name} didn't answer`;
    case 'unavailable': return `${name} isn't available right now`;
    case 'failed': return out.message ?? `Couldn't call ${name}`;
  }
  return '';
}

function Outgoing({ out, phone, onCancel }: { out: OutgoingCall; phone: boolean; onCancel: () => void }) {
  const name = out.peer.username;
  const peerUrl = out.peer.avatarUrl;
  const calling = out.status === 'calling';
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') onCancel(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onCancel]);
  if (phone) {
    return (
      <div role="dialog" aria-label={`Calling ${name}`} class="pcall pcall-out">
        <div class="pcall-who">
          <Avatar nick={name} accountUrl={peerUrl} size={120} class={`pcall-av${calling ? ' call-pulse' : ''}`} />
          <span class="pcall-name">{name}</span>
          <span class="pcall-sub" aria-live="polite">{calling ? `Calling… · ${out.video ? 'video' : 'voice'}` : outcomeText(out)}</span>
        </div>
        <div class="pcall-buttons pcall-buttons-one">
          <div class="pcall-btn-wrap">
            <button type="button" class="pcall-btn pcall-btn-danger" aria-label={calling ? 'Cancel call' : 'Close'} onClick={onCancel}>
              <PhoneOff size={28} aria-hidden="true" />
            </button>
          </div>
        </div>
      </div>
    );
  }
  return (
    <div class="ocall-backdrop">
      <div role="dialog" aria-label={`Calling ${name}`} class="ocall">
        <Avatar nick={name} accountUrl={peerUrl} size={84} class="ocall-av" />
        <span class="ocall-name">{calling ? `Calling ${name}…` : name}</span>
        <span class="ocall-sub" aria-live="polite">
          {calling ? `${out.video ? 'Video call' : 'Voice call'} · ringing for up to 45 s` : outcomeText(out)}
        </span>
        <div class="ocall-actions">
          <button type="button" class={`call-btn ${calling ? 'call-btn-danger' : ''}`} onClick={onCancel}>{calling ? 'Cancel' : 'Close'}</button>
        </div>
      </div>
    </div>
  );
}

function Incoming({ call, phone, onDecline, onVoice, onAccept }: {
  call: CallInfo; phone: boolean; onDecline: () => void; onVoice: () => void; onAccept: () => void;
}) {
  const name = call.peer.username;
  const peerUrl = call.peer.avatarUrl;
  const kind = call.video ? 'video' : 'voice';
  if (phone) {
    return (
      <div role="alertdialog" aria-label={`${name} is calling`} class="pcall pcall-in">
        <div class="pcall-who">
          <Avatar nick={name} accountUrl={peerUrl} size={120} class="pcall-av call-pulse" />
          <span class="pcall-name">{name}</span>
          <span class="pcall-sub pcall-sub-ok">is calling you · {kind}</span>
        </div>
        <div class="pcall-buttons">
          <div class="pcall-btn-wrap">
            <button type="button" class="pcall-btn pcall-btn-danger" aria-label="Decline" onClick={onDecline}><PhoneOff size={28} aria-hidden="true" /></button>
            <span class="pcall-btn-label">Decline</span>
          </div>
          {call.video && (
            <div class="pcall-btn-wrap">
              <button type="button" class="pcall-btn pcall-btn-plain" aria-label="Accept with voice only" onClick={onVoice}><Mic size={24} aria-hidden="true" /></button>
              <span class="pcall-btn-label">Voice only</span>
            </div>
          )}
          <div class="pcall-btn-wrap">
            <button type="button" class="pcall-btn pcall-btn-ok call-answer" aria-label="Accept" onClick={onAccept}><Phone size={28} aria-hidden="true" /></button>
            <span class="pcall-btn-label pcall-btn-label-ok">Accept</span>
          </div>
        </div>
      </div>
    );
  }
  // Desktop, full screen: over the whole window.
  return (
    <div class="fcall-backdrop">
      <div role="alertdialog" aria-label={`${name} is calling`} class="fcall">
        <div class="pcall-who">
          <Avatar nick={name} accountUrl={peerUrl} size={112} class="pcall-av call-pulse" />
          <span class="pcall-name">{name}</span>
          <span class="pcall-sub pcall-sub-ok">is calling you · {kind}</span>
        </div>
        <div class="fcall-buttons">
          <div class="pcall-btn-wrap">
            <button type="button" class="pcall-btn pcall-btn-danger" aria-label="Decline" onClick={onDecline}><PhoneOff size={28} aria-hidden="true" /></button>
            <span class="pcall-btn-label">Decline</span>
          </div>
          {call.video && (
            <div class="pcall-btn-wrap">
              <button type="button" class="pcall-btn pcall-btn-plain" aria-label="Accept with voice only" onClick={onVoice}><Mic size={24} aria-hidden="true" /></button>
              <span class="pcall-btn-label">Voice only</span>
            </div>
          )}
          <div class="pcall-btn-wrap">
            <button type="button" class="pcall-btn pcall-btn-ok call-answer" aria-label="Accept" onClick={onAccept}><Phone size={28} aria-hidden="true" /></button>
            <span class="pcall-btn-label pcall-btn-label-ok">Accept</span>
          </div>
        </div>
      </div>
    </div>
  );
}
