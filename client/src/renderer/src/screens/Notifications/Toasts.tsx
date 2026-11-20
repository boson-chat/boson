import { useEffect, useRef, useState } from 'preact/hooks';
import { createPortal } from 'preact/compat';
import { Mic, Phone, PhoneOff, X } from 'lucide-preact';
import { Avatar } from '../../shared/Avatar/Avatar';
import { useNarrow } from '../../shared/narrow';
import { isMobile } from '../../shared/window-controls';
import { useFriends, type CallInfo } from '../../modules/friends';
import { getNotificationFeed, type Toast } from '../../modules/notifications/feed';
import { useFeed } from '../../modules/notifications/use-feed';
import { useNotificationSettings } from '../../modules/notifications/use-settings';
import { incomingCallStyle } from '../../modules/ui/notifications.store';
import { getMemoStore } from '../../modules/memos';
import { joinVoice, openCalls, openConversation, openFriends } from './navigate';
import { expandRing, useRingExpanded } from './ring-ui';
import './Toasts.css';

/** How long a toast stays (ms); hovering or focusing it pauses the time. */
export const TOAST_MS = 6_000;

// In-app notifications for things happening somewhere you're not looking:
// desktop cards stacked top right (at most three, newest on top), a banner
// dropping from the top on phones. An incoming call shown as a banner (the
// "Incoming calls: Banner" setting) is one of them, with Decline, Voice
// only and Accept; it stays until it's answered, declined or stops ringing.
export function Toasts() {
  const narrow = useNarrow();
  const phone = narrow || isMobile();
  const { toasts } = useFeed();
  const { friends, snap } = useFriends();
  const settings = useNotificationSettings();
  const ringing = snap.ringing[0] ?? null;
  const expanded = useRingExpanded(ringing?.id ?? null);
  const ringBanner = ringing && !snap.calling && !expanded && incomingCallStyle(phone, settings) === 'banner' ? ringing : null;
  const feed = getNotificationFeed();
  // Phones show one at a time: the ringing call, else the newest.
  const shown = phone ? (ringBanner ? [] : toasts.slice(0, 1)) : toasts.slice(0, ringBanner ? 2 : 3);
  if (!ringBanner && shown.length === 0) return null;
  return createPortal(
    <div class={`ntoasts${phone ? ' ntoasts-phone' : ''}`} aria-live="polite" aria-label="Notifications">
      {ringBanner && friends && (
        <RingToast key={ringBanner.id} call={ringBanner} phone={phone}
          onDecline={() => { void friends.decline(ringBanner.id); }}
          onVoice={() => { void friends.accept(ringBanner.id, false); }}
          onAccept={() => { void friends.accept(ringBanner.id, ringBanner.video); }}
          onExpand={() => expandRing(ringBanner.id)} />
      )}
      {shown.map((t) => <ToastCard key={t.id} t={t} phone={phone} onClose={() => feed.dismiss(t.id)} />)}
    </div>,
    document.body,
  );
}

// Opens what a toast is about, and marks its list entry read.
export function openToast(t: Toast): void {
  const feed = getNotificationFeed();
  feed.dismiss(t.id);
  if (t.feedId) feed.markRead(t.feedId);
  switch (t.kind) {
    case 'mention': case 'dm': case 'message': {
      // Its inbox entry (a mention or DM) is seen now.
      const m = getMemoStore().list().find((x) => !x.read && x.serverId === t.serverId && x.sender === t.nick && (t.kind === 'dm' ? x.kind === 'dm' : x.channel?.toLowerCase() === t.channel?.toLowerCase()));
      if (m) getMemoStore().markRead(m.id);
      openConversation(t.serverId ?? '', t.channel ?? null);
      return;
    }
    case 'friend': case 'accepted': openFriends(); return;
    case 'missed': openCalls(); return;
    case 'started': if (t.room) joinVoice(t.room); return;
  }
}

// The time left before a toast goes, paused while the pointer or focus is
// on it.
function useToastTimer(onDone: () => void): { paused: boolean; pause: () => void; resume: () => void } {
  const [paused, setPaused] = useState(false);
  const left = useRef(TOAST_MS);
  const started = useRef(Date.now());
  const done = useRef(onDone);
  done.current = onDone;
  useEffect(() => {
    if (paused) return;
    started.current = Date.now();
    const t = setTimeout(() => done.current(), left.current);
    return () => {
      clearTimeout(t);
      left.current = Math.max(0, left.current - (Date.now() - started.current));
    };
  }, [paused]);
  return { paused, pause: () => setPaused(true), resume: () => setPaused(false) };
}

function ToastCard({ t, phone, onClose }: { t: Toast; phone: boolean; onClose: () => void }) {
  const { friends } = useFriends();
  const timer = useToastTimer(onClose);
  const label = [t.title, t.where].filter(Boolean).join(' · ');
  const actions = t.kind === 'friend' && t.friend && friends ? (
    <>
      <button type="button" class="call-btn call-btn-ok" aria-label={`Accept ${t.friend.username}'s friend request`}
        onClick={() => { void friends.acceptRequest(t.friend!); onClose(); }}>Accept</button>
      <button type="button" class="call-btn" aria-label={`Ignore ${t.friend.username}'s friend request`}
        onClick={() => { void friends.deleteRequest(t.friend!); onClose(); }}>Ignore</button>
    </>
  ) : t.kind === 'missed' && t.call && friends ? (
    <>
      <button type="button" class="call-btn call-btn-ok" aria-label={`Call ${t.call.peer} back`}
        onClick={() => { void friends.call(t.call!.peer, t.call!.video); onClose(); }}>
        <Phone size={13} strokeWidth={2.5} aria-hidden="true" />Call back
      </button>
      <button type="button" class="call-btn" onClick={onClose}>Dismiss</button>
    </>
  ) : t.kind === 'started' && t.room ? (
    <>
      <button type="button" class="call-btn call-btn-ok" aria-label={`Join ${t.room.name}`} onClick={() => openToast(t)}>Join</button>
      <button type="button" class="call-btn" onClick={onClose}>Dismiss</button>
    </>
  ) : null;
  return (
    <div class={`ntoast${phone ? ' ntoast-phone' : ''}${timer.paused ? ' ntoast-paused' : ''}`} role="group" aria-label={label}
      onMouseEnter={timer.pause} onMouseLeave={timer.resume} onFocusIn={timer.pause} onFocusOut={timer.resume}>
      <button type="button" class="ntoast-main" onClick={() => openToast(t)}
        aria-label={`${label}: ${t.body}. Open`}>
        {t.nick ? <Avatar nick={t.nick} size={phone ? 36 : 34} class="ntoast-av" /> : <span class="ntoast-av ntoast-av-live" aria-hidden="true">◉</span>}
        <span class="ntoast-text">
          <span class="ntoast-head">
            <span class="ntoast-title">{t.title}</span>
            {t.where && <span class="ntoast-where">{t.where}</span>}
          </span>
          <span class="ntoast-body">{t.body}</span>
        </span>
      </button>
      {actions && <div class="ntoast-actions">{actions}</div>}
      <button type="button" class="ntoast-x" aria-label="Dismiss" onClick={onClose}><X size={14} aria-hidden="true" /></button>
      <span class="ntoast-bar" aria-hidden="true" style={{ animationDuration: `${TOAST_MS}ms` }} />
    </div>
  );
}

function RingToast({ call, phone, onDecline, onVoice, onAccept, onExpand }: {
  call: CallInfo; phone: boolean; onDecline: () => void; onVoice: () => void; onAccept: () => void; onExpand: () => void;
}) {
  const name = call.peer.username;
  const kind = call.video ? 'video' : 'voice';
  if (phone) {
    return (
      <div class="ntoast ntoast-phone ntoast-ring" role="alertdialog" aria-label={`${name} is calling`}>
        <button type="button" class="ntoast-main" onClick={onExpand} aria-label={`${name} is calling you, ${kind}. Open full screen`}>
          <Avatar nick={name} size={40} class="ntoast-av call-pulse-sm" />
          <span class="ntoast-text">
            <span class="ntoast-title">{name}</span>
            <span class="ntoast-body ntoast-body-ok">is calling you · {kind}</span>
          </span>
        </button>
        <div class="ntoast-round">
          <button type="button" class="pcall-btn pcall-btn-danger ntoast-rbtn" aria-label="Decline" onClick={onDecline}><PhoneOff size={20} aria-hidden="true" /></button>
          {call.video && <button type="button" class="pcall-btn ntoast-rbtn" aria-label="Accept with voice only" onClick={onVoice}><Mic size={20} aria-hidden="true" /></button>}
          <button type="button" class="pcall-btn pcall-btn-ok ntoast-rbtn call-answer" aria-label="Accept" onClick={onAccept}><Phone size={20} aria-hidden="true" /></button>
        </div>
      </div>
    );
  }
  return (
    <div class="ntoast ntoast-ring" role="alertdialog" aria-label={`${name} is calling`}>
      <button type="button" class="ntoast-main" onClick={onExpand} aria-label={`${name} is calling you, ${kind}. Open full screen`}>
        <Avatar nick={name} size={34} class="ntoast-av call-pulse-sm" />
        <span class="ntoast-text">
          <span class="ntoast-head">
            <span class="ntoast-title">{name} is calling</span>
            <span class="ntoast-where">{kind} call</span>
          </span>
          <span class="ntoast-body">Accept, {call.video ? 'take it voice only, ' : ''}or decline.</span>
        </span>
      </button>
      <div class="ntoast-actions">
        <button type="button" class="call-btn call-btn-danger" aria-label="Decline call" onClick={onDecline}>Decline</button>
        {call.video && <button type="button" class="call-btn" aria-label="Accept with voice only" onClick={onVoice}>Voice only</button>}
        <button type="button" class="call-btn call-btn-ok call-answer" aria-label="Accept call" onClick={onAccept}>
          <Phone size={13} strokeWidth={2.5} aria-hidden="true" />Accept
        </button>
      </div>
    </div>
  );
}
