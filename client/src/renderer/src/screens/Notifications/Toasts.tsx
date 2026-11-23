import { useEffect, useRef, useState } from 'preact/hooks';
import { createPortal } from 'preact/compat';
import { Mic, Phone, PhoneOff, X } from 'lucide-preact';
import { Avatar as Tile, Button, Toast as ToastBox } from '@boson/shared';
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
    case 'undo': return;
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
  const size = phone ? 'lg' : 'sm';
  const actions = t.kind === 'friend' && t.friend && friends ? (
    <>
      <Button variant="success" size={size} aria-label={`Accept ${t.friend.username}'s friend request`}
        onClick={() => { void friends.acceptRequest(t.friend!); onClose(); }}>Accept</Button>
      <Button variant="secondary" size={size} aria-label={`Ignore ${t.friend.username}'s friend request`}
        onClick={() => { void friends.deleteRequest(t.friend!); onClose(); }}>Ignore</Button>
    </>
  ) : t.kind === 'missed' && t.call && friends ? (
    <>
      <Button variant="success" size={size} icon={<Phone aria-hidden="true" />} aria-label={`Call ${t.call.peer} back`}
        onClick={() => { void friends.call(t.call!.peer, t.call!.video); onClose(); }}>Call back</Button>
      <Button variant="secondary" size={size} onClick={onClose}>Dismiss</Button>
    </>
  ) : t.kind === 'undo' && t.undo ? (
    <Button variant="secondary" size={size} onClick={() => { t.undo!(); onClose(); }}>Undo</Button>
  ) : t.kind === 'started' && t.room ? (
    <>
      <Button variant="success" size={size} aria-label={`Join ${t.room.name}`} onClick={() => openToast(t)}>Join</Button>
      <Button variant="secondary" size={size} onClick={onClose}>Dismiss</Button>
    </>
  ) : null;
  return (
    <ToastBox
      class="ntoast" surface={phone ? 'phone' : 'desktop'} role="group" ariaLabel={label}
      boxProps={{ onMouseEnter: timer.pause, onMouseLeave: timer.resume, onFocusIn: timer.pause, onFocusOut: timer.resume }}
      onOpen={t.kind === 'undo' ? undefined : () => openToast(t)} openLabel={`${label}: ${t.body}. Open`}
      leading={t.nick
        ? <Avatar nick={t.nick} serverId={t.serverId} accountUrl={t.friend?.avatarUrl} size={phone ? 36 : 34} />
        : t.kind === 'undo'
          ? <Tile size={34} initial="#" color="var(--fg-3)" />
          : <Tile size={34} initial="◉" color="var(--success)" />}
      title={t.title} meta={t.where || undefined} body={t.body}
      actions={actions ?? undefined}
      onDismiss={onClose} dismissIcon={<X aria-hidden="true" />}
      timerMs={TOAST_MS} paused={timer.paused}
    />
  );
}

// The incoming call as a banner (option D): one row, as tall as a message
// banner — who, "video call" / "voice call", then square Decline, Voice
// only (video calls) and Accept (pulses). Tapping the row opens the call
// full screen. Phones and desktop use the same banner.
function RingToast({ call, phone, onDecline, onVoice, onAccept, onExpand }: {
  call: CallInfo; phone: boolean; onDecline: () => void; onVoice: () => void; onAccept: () => void; onExpand: () => void;
}) {
  const name = call.peer.username;
  const kind = call.video ? 'video' : 'voice';
  const size = phone ? 'lg' : 'md';
  return (
    <ToastBox class="ntoast ntoast-ring" surface={phone ? 'phone' : 'desktop'} layout="row" role="alertdialog" ariaLabel={`${name} is calling`}
      onOpen={onExpand} openLabel={`${name} is calling you, ${kind}. Open full screen`}
      leading={<Avatar nick={name} accountUrl={call.peer.avatarUrl} size={36} />}
      title={name} body={`${kind} call`} bodyTone="success"
      actions={<>
        <Button variant="danger" size={size} icon={<PhoneOff aria-hidden="true" />} aria-label={phone ? 'Decline' : 'Decline call'} onClick={onDecline} />
        {call.video && <Button variant="secondary" size={size} icon={<Mic aria-hidden="true" />} aria-label="Accept with voice only" onClick={onVoice} />}
        <Button variant="success" size={size} attention class="call-answer" icon={<Phone aria-hidden="true" />} aria-label={phone ? 'Accept' : 'Accept call'} onClick={onAccept} />
      </>} />
  );
}
