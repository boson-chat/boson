import { useEffect, useRef, useState } from 'preact/hooks';
import { MicOff, Mic, Video, VideoOff, Volume2 } from 'lucide-preact';
import { useVideo } from '../../modules/video';
import type { VoiceRoom, VoiceRoomParticipant } from '../../modules/voice';
import { Avatar } from '../../shared/Avatar/Avatar';
import { BottomSheet } from './BottomSheet';
import { setVoiceUi, useVoiceServer, useVoiceUi, type VoiceView } from './VoiceRooms';
import { isGuestParticipant } from '../../modules/voice/guest-id';
import { GuestBadge } from './GuestBadge';
import './PreJoin.css';

// Before joining a voice channel: who's there, your camera preview (or
// your avatar), mic and camera toggles, and "Join call". The desktop shows
// it in the main column (VoicePreJoin), a phone as a bottom sheet
// (VoiceJoinSheet). Nobody joins by accident, or with their camera on.

/** "kestrel, mira and juno are here." / "… and N others are here." */
export function hereText(names: readonly string[]): string {
  if (names.length === 0) return "Nobody's here yet.";
  if (names.length === 1) return `${names[0]} is here.`;
  if (names.length <= 3) return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]} are here.`;
  const more = names.length - 3;
  return `${names.slice(0, 3).join(', ')} and ${more} ${more === 1 ? 'other is' : 'others are'} here.`;
}

/** How someone in the room is doing, for the join sheet's list. */
export function personState(p: VoiceRoomParticipant): { text: string; tone: 'speaking' | 'quiet' } {
  if (p.speaking) return { text: 'speaking', tone: 'speaking' };
  if (p.deafened) return { text: 'deafened', tone: 'quiet' };
  if (p.muted) return { text: 'muted', tone: 'quiet' };
  return { text: 'listening', tone: 'quiet' };
}

// The room being viewed, the choices made here, and joining.
function usePreJoin(view: VoiceView | null) {
  const { voice, snap, server } = useVoiceServer(view?.host ?? '');
  const { video, snap: vsnap } = useVideo();
  const call = snap.call;
  const joinedHere = !!view && call.host === view.host && call.room === view.roomId && call.status !== 'idle' && call.status !== 'error';
  const room: VoiceRoom | null = !view ? null
    : server?.rooms?.find((r) => r.id === view.roomId) ?? { id: view.roomId, name: view.roomId, participants: [] };
  const preview = vsnap.state.preview;
  const canPreview = !!video && vsnap.state.canCapture !== false && preview !== undefined;
  // Without a preview (older shells, watch-only builds), the choice alone.
  const [camWish, setCamWish] = useState(false);
  const camOn = canPreview ? !!(preview?.on || preview?.starting) : camWish;
  const joining = useRef(false);

  // Leaving the view without joining stops the preview.
  useEffect(() => () => {
    if (!joining.current && video && (video.getSnapshot().state.preview?.on || video.getSnapshot().state.preview?.starting)) {
      void video.previewCamera(false);
    }
  }, [view?.host, view?.roomId]);

  return {
    voice, room, joinedHere, call, video, vsnap, canPreview, camOn,
    micOn: !call.muted,
    toggleMic: () => { void voice?.setMuted(!call.muted); },
    toggleCam: () => {
      if (canPreview) void video!.previewCamera(!camOn, preview?.id ?? '');
      else setCamWish(!camWish);
    },
    join: () => {
      if (!voice || !room || !view) return;
      joining.current = true;
      video?.setCameraOnJoin(camOn, preview?.id ?? '');
      video?.setOpen(true);
      void voice.join(view.host, room, view.serverName);
    },
    close: () => setVoiceUi({ view: null }),
  };
}

function PreviewTile({ camOn, starting, error, self, selfAvatar, facing, attach, cls }: {
  camOn: boolean; starting: boolean; error?: string; self: string; selfAvatar?: string; facing?: string;
  attach: (el: HTMLCanvasElement | null) => void; cls: string;
}) {
  return (
    <div class={cls} data-on={camOn || undefined}>
      {camOn ? (
        <>
          <canvas class="prejoin-preview-video" ref={attach} data-mirror={facing !== 'back' || undefined} />
          {starting && <span class="prejoin-preview-note">Starting camera…</span>}
        </>
      ) : (
        <div class="prejoin-preview-off">
          <Avatar nick={self} url={selfAvatar} size={44} />
          <span>{error || 'Your camera is off'}</span>
        </div>
      )}
    </div>
  );
}

/** Desktop: the voice channel's pre-join view, in place of the chat. */
export function VoicePreJoin({ self, avatarFor }: { self: string; avatarFor?: (nick: string) => string | undefined }) {
  const { view } = useVoiceUi();
  const j = usePreJoin(view);
  if (!view || !j.room || j.joinedHere) return null;
  const people = j.room.participants;
  const tiles = people.length > 3 ? people.slice(0, 3) : people;
  const preview = j.vsnap.state.preview;
  return (
    <main class="prejoin" aria-label={`Join ${j.room.name}`}>
      <header class="prejoin-head">
        <Volume2 size={20} aria-hidden="true" />
        <span class="prejoin-title">{j.room.name}</span>
        <span class="prejoin-count">{people.length} in call</span>
      </header>
      <div class="prejoin-body">
        <div class="prejoin-tiles" aria-label={`In ${j.room.name}`}>
          {tiles.map((p) => (
            <div key={`${p.sessionId}:${p.userId}`} class="prejoin-tile" data-speaking={p.speaking || undefined}>
              <Avatar nick={p.name} url={avatarFor?.(p.name)} size={72} />
              <span class="prejoin-tag">
                {p.name}
                {isGuestParticipant(p) && <GuestBadge />}
                {(p.muted || p.deafened) && <MicOff size={12} class="prejoin-muted" aria-label="muted" />}
              </span>
            </div>
          ))}
          {people.length > 3 && <div class="prejoin-tile prejoin-more">+{people.length - 3} more</div>}
          {people.length === 0 && <div class="prejoin-tile prejoin-empty">Nobody's here yet.</div>}
        </div>
        <div class="prejoin-bar">
          <PreviewTile cls="prejoin-preview" camOn={j.camOn} starting={!!preview?.starting} error={preview?.error}
            self={self} selfAvatar={avatarFor?.(self)} facing={preview?.facing} attach={(el) => j.video?.attachPreview(el)} />
          <div class="prejoin-text">
            <span class="prejoin-join-title">Join {j.room.name}</span>
            <span class="prejoin-here">{hereText(people.map((p) => p.name))} Pick how you join; you can change it any time.</span>
          </div>
          <div class="prejoin-actions">
          <button type="button" class="prejoin-btn" data-off={!j.micOn || undefined} aria-pressed={!j.micOn}
            aria-label={j.micOn ? 'Mute' : 'Unmute'} title={j.micOn ? 'Join with your mic on (click to mute)' : 'Join muted (click to unmute)'} onClick={j.toggleMic}>
            {j.micOn ? <Mic size={20} aria-hidden="true" /> : <MicOff size={20} aria-hidden="true" />}
          </button>
          <button type="button" class="prejoin-btn" data-off={!j.camOn || undefined} aria-pressed={j.camOn}
            aria-label={j.camOn ? 'Turn camera off' : 'Turn camera on'} title={j.camOn ? 'Join with your camera on' : 'Join with your camera off'} onClick={j.toggleCam}>
            {j.camOn ? <Video size={20} aria-hidden="true" /> : <VideoOff size={20} aria-hidden="true" />}
          </button>
          <button type="button" class="prejoin-join" onClick={j.join}>Join call</button>
          </div>
        </div>
      </div>
    </main>
  );
}

/** Phone: the voice channel's join sheet. */
export function VoiceJoinSheet({ self, avatarFor }: { self: string; avatarFor?: (nick: string) => string | undefined }) {
  const { view } = useVoiceUi();
  const j = usePreJoin(view);
  const [all, setAll] = useState(!!view?.expanded);
  useEffect(() => setAll(!!view?.expanded), [view?.host, view?.roomId, view?.expanded]);
  if (!view || !j.room || j.joinedHere) return null;
  const people = j.room.participants;
  const shown = all ? people : people.slice(0, 3);
  const preview = j.vsnap.state.preview;
  return (
    <BottomSheet
      label={`Join ${j.room.name}`}
      onClose={j.close}
      actions={[]}
      header={(
        <div class="joinsheet-head">
          <Volume2 size={20} aria-hidden="true" />
          <span class="joinsheet-title">{j.room.name}</span>
          <span class="joinsheet-count">{people.length} here now</span>
        </div>
      )}
    >
      <div class="joinsheet">
        <div class="joinsheet-here" aria-label="Here now" data-all={all || undefined}>
          {shown.map((p) => {
            const st = personState(p);
            return (
              <div key={`${p.sessionId}:${p.userId}`} class="joinsheet-person">
                <span class="joinsheet-face" data-speaking={p.speaking || undefined}><Avatar nick={p.name} url={avatarFor?.(p.name)} size={28} /></span>
                <span class="joinsheet-who">
                  <span class="joinsheet-name">{p.name}{isGuestParticipant(p) && <> <GuestBadge /></>}</span>
                  <span class="joinsheet-state" data-tone={st.tone}>{st.text}</span>
                </span>
                {(p.muted || p.deafened) && <MicOff size={16} class="joinsheet-muted" aria-label="muted" />}
              </div>
            );
          })}
          {people.length === 0 && <div class="joinsheet-person joinsheet-empty">Nobody's here yet.</div>}
          {!all && people.length > 3 && (
            <button type="button" class="joinsheet-more" aria-label={`Show everyone in ${j.room.name}`} onClick={() => setAll(true)}>
              <span class="joinsheet-more-faces">
                {people.slice(3, 9).map((p) => (
                  <span key={`${p.sessionId}:${p.userId}`} class="joinsheet-more-face"><Avatar nick={p.name} url={avatarFor?.(p.name)} size={24} /></span>
                ))}
              </span>
              <span class="joinsheet-more-text">and {people.length - 3} more</span>
              <span class="joinsheet-more-link">Show all</span>
            </button>
          )}
          {all && people.length > 3 && (
            <button type="button" class="joinsheet-fewer" onClick={() => setAll(false)}>Show fewer</button>
          )}
        </div>
        <PreviewTile cls="joinsheet-preview" camOn={j.camOn} starting={!!preview?.starting} error={preview?.error}
          self={self} selfAvatar={avatarFor?.(self)} facing={preview?.facing} attach={(el) => j.video?.attachPreview(el)} />
        <div class="joinsheet-toggles">
          <button type="button" class="joinsheet-tog" data-off={!j.micOn || undefined} aria-pressed={j.micOn} onClick={j.toggleMic}>
            {j.micOn ? <Mic size={22} aria-hidden="true" /> : <MicOff size={22} aria-hidden="true" />}
            {j.micOn ? 'Mic on' : 'Muted'}
          </button>
          <button type="button" class="joinsheet-tog" data-off={!j.camOn || undefined} aria-pressed={j.camOn} onClick={j.toggleCam}>
            {j.camOn ? <Video size={22} aria-hidden="true" /> : <VideoOff size={22} aria-hidden="true" />}
            {j.camOn ? 'Camera on' : 'Camera off'}
          </button>
        </div>
        <button type="button" class="joinsheet-join" onClick={j.join}>Join call</button>
      </div>
    </BottomSheet>
  );
}
