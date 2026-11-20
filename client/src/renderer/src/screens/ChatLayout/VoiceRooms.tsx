import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { createPortal } from 'preact/compat';
import { ChevronDown, HeadphoneOff, Lock, MicOff, Plus, Settings, Video, Volume2 } from 'lucide-preact';
import { useVideo } from '../../modules/video';
import { useNarrow } from '../../shared/narrow';
import {
  roomsUnder, useVoice, type VoiceController, type VoiceParticipant, type VoiceRole, type VoiceRoom,
  type VoiceRoomParticipant, type VoiceRoomPermissions, type VoiceServerView,
} from '../../modules/voice';
import { Avatar } from '../../shared/Avatar/Avatar';
import { isGuestParticipant } from '../../modules/voice/guest-id';
import { GuestBadge } from './GuestBadge';
import './NickContextMenu.css';
import './VoiceSection.css';

// Voice channels in the channel list, Discord style: each IRC channel's
// voice channels hang under it, the rest sit in the VOICE section. This file
// has the pieces both places share (a room row with who's in it, the "+"
// that makes one, the right-click menus) and a small store for the one open
// dialog or menu, which VoiceSection renders.

// ---- which dialog / menu is open ----

export type VoiceDialog =
  | { kind: 'create'; host: string; parent: string | null }
  | { kind: 'edit'; host: string; roomId: string; confirmDelete?: boolean };

// The voice channel you're looking at (clicked in the sidebar): its
// pre-join view (desktop) or join sheet (phone) until you join, then the
// call. expanded: the join sheet opens with everyone listed ("see all").
export interface VoiceView {
  host: string;
  roomId: string;
  serverName: string;
  expanded?: boolean;
}

interface VoiceUiState {
  view: VoiceView | null;
  dialog: VoiceDialog | null;
  roomMenu: { host: string; roomId: string; x: number; y: number } | null;
  userMenu: { p: VoiceRoomParticipant; x: number; y: number } | null;
}

let ui: VoiceUiState = { view: null, dialog: null, roomMenu: null, userMenu: null };
const uiListeners = new Set<(s: VoiceUiState) => void>();

export function setVoiceUi(patch: Partial<VoiceUiState>): void {
  ui = { ...ui, ...patch };
  uiListeners.forEach((fn) => fn(ui));
}

export function useVoiceUi(): VoiceUiState {
  const [s, set] = useState(ui);
  useEffect(() => {
    uiListeners.add(set);
    set(ui);
    return () => { uiListeners.delete(set); };
  }, []);
  return s;
}

// ---- permissions ----

// Whether you may make a voice channel under `parent` ('' = top level).
export function canCreateUnder(perms: VoiceRoomPermissions, parent: string): boolean {
  if (!perms.canCreate) return false;
  if (perms.createScope === 'any') return true;
  if (perms.createScope !== 'founded_channels' || !parent) return false;
  return (perms.foundedChannels ?? []).includes(parent.toLowerCase());
}

const ROLE_SHORT: Record<VoiceRole, string> = {
  member: 'anyone', voice: 'voice (+v)', halfop: 'half-op (%)', op: 'op (@)',
  admin: 'channel admin (&)', founder: 'the founder (~)', oper: 'network admins',
};

export function roleShort(r: VoiceRole | undefined): string {
  return ROLE_SHORT[r ?? 'member'] ?? r ?? 'anyone';
}

// Why a room can't be joined, for its tooltip.
export function lockReason(r: VoiceRoom): string {
  const where = r.parent ? ` in ${r.parent}` : '';
  if (r.minRole === 'oper') return 'Only network admins can join';
  if (r.minRole && r.minRole !== 'member') {
    return r.minRole === 'founder' ? `Only the founder of ${r.parent} can join` : `Needs ${roleShort(r.minRole)} or higher${where}`;
  }
  if (r.requireChannelMembership && r.parent) return `Join ${r.parent} to use this voice channel`;
  return "You can't join this voice channel";
}

// ---- a room and who's in it ----

export function useVoiceServer(host: string): {
  voice: VoiceController | null;
  key: string;
  server: VoiceServerView | undefined;
  snap: ReturnType<typeof useVoice>['snap'];
} {
  const { voice, snap } = useVoice();
  const key = host.trim().toLowerCase();
  return { voice, snap, key, server: snap.servers[key] };
}

// The most people listed under a room before it's cut to SIDE_SHOWN plus
// "+N more · see all".
const SIDE_MAX = 7;
const SIDE_SHOWN = 5;

type LiveParticipant = VoiceRoomParticipant & { self?: boolean; volume?: number; listener?: boolean };

/** Who's in a room as the sidebar shows them: what video each sends (only
 * known in the call you're in), and the order for a cut-down list: you,
 * then speakers, then sharers. */
export function roomPeople(live: LiveParticipant[], video: { userId: string; kind: 'camera' | 'screen'; self: boolean }[], selfCamera: boolean, selfScreen: boolean) {
  const people = live.map((p) => ({
    p,
    self: !!p.self,
    screen: p.self ? selfScreen : video.some((t) => !t.self && t.userId === p.userId && t.kind === 'screen'),
    camera: p.self ? selfCamera : video.some((t) => !t.self && t.userId === p.userId && t.kind === 'camera'),
  }));
  const rank = (x: typeof people[number]) => (x.self ? 4 : 0) + (x.p.speaking ? 2 : 0) + (x.screen ? 1 : 0);
  const capped = people.length > SIDE_MAX ? [...people].sort((a, b) => rank(b) - rank(a)).slice(0, SIDE_SHOWN) : people;
  // The face stack: speakers first, three at most.
  const faces = [...people].sort((a, b) => (b.p.speaking ? 1 : 0) - (a.p.speaking ? 1 : 0)).slice(0, 3);
  return { people, capped, faces, more: Math.max(0, people.length - 3), hidden: people.length - capped.length };
}

export function VoiceRoomRow({ snap, host, server, room, serverName, nested, avatarFor, onSeeAll }: {
  voice: VoiceController;
  snap: ReturnType<typeof useVoice>['snap'];
  host: string;
  server: VoiceServerView;
  room: VoiceRoom;
  serverName: string;
  // Under a text channel (indented a step).
  nested?: boolean;
  avatarFor?: (nick: string) => string | undefined;
  // "+N more · see all" under a busy room (default: list everyone).
  onSeeAll?: () => void;
}) {
  const { video, snap: vsnap } = useVideo();
  const [peek, setPeek] = useState(false);
  const [all, setAll] = useState(false);
  const narrow = useNarrow(); // a phone: bigger faces, a 44px tap target
  const call = snap.call;
  const callHere = call.host === host && (call.status === 'connected' || call.status === 'connecting');
  const inThis = callHere && call.room === room.id;
  const locked = room.canJoin === false && !inThis;
  const listenOnly = room.canSpeak === false && !locked && !inThis;
  const joinable = server.audio && !locked;
  const live: LiveParticipant[] =
    inThis && call.status === 'connected' && call.participants.length > 0 ? call.participants : room.participants;
  // Before you join, who's in shows as faces; their names on request
  // ("peek"). In the call, always.
  const showList = inThis || peek;
  const vstate = vsnap.state;
  const { capped, faces, more, hidden } = roomPeople(live, inThis ? vstate.tracks : [], inThis && vstate.camera.on, inThis && vstate.screen.on);
  const listed = all ? roomPeople(live, inThis ? vstate.tracks : [], inThis && vstate.camera.on, inThis && vstate.screen.on).people : capped;
  const seeAll = (): void => {
    if (onSeeAll) onSeeAll();
    else if (inThis || joinable) open(true);
    else setAll(true);
  };
  // A click opens the channel: its pre-join view (or join sheet) where you
  // pick mic and camera and then join; the call if you're in it. No
  // one-click joins.
  const open = (expanded = false): void => {
    if (inThis) {
      if (video && vstate.available) video.setOpen(true);
      setVoiceUi({ view: { host, roomId: room.id, serverName } });
      return;
    }
    if (joinable) setVoiceUi({ view: { host, roomId: room.id, serverName, expanded } });
  };
  const title = !server.audio ? "Voice audio isn't available in this build"
    : locked ? lockReason(room)
      : inThis ? 'Connected'
        : listenOnly ? `Join ${room.name} to listen (talking needs ${roleShort(room.speakRole)})`
          : `Open ${room.name}`;
  return (
    <div class={`voice-room ${nested ? 'voice-room-nested' : ''}`} data-room={room.id}>
      <div class="voice-room-line">
      <div
        class={`channel-item voice-room-row ${inThis ? 'channel-item-active voice-room-incall' : ''}`}
        role="button"
        tabIndex={joinable ? 0 : -1}
        aria-disabled={!joinable || undefined}
        aria-label={inThis ? `${room.name} (connected)` : locked ? `${room.name} (locked)` : `Voice channel ${room.name}${listenOnly ? ', listen only' : ''}`}
        title={title}
        data-state={inThis ? call.status : undefined}
        data-locked={locked || undefined}
        onClick={() => open()}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            open();
          }
        }}
        onContextMenu={(e) => {
          if (!room.canManage) return;
          e.preventDefault();
          setVoiceUi({ roomMenu: { host, roomId: room.id, x: e.clientX, y: e.clientY }, userMenu: null });
        }}
      >
        <span class="channel-hash voice-room-icon">
          {inThis && call.status === 'connecting'
            ? <span class="channel-sync-spinner" data-sync="loading" aria-hidden="true" />
            : locked
              ? <Lock size={13} aria-hidden="true" />
              : <Volume2 size={14} aria-hidden="true" />}
        </span>
        <span class="channel-name">{room.name}</span>
        {listenOnly && <span class="voice-room-badge" aria-hidden="true">listen only</span>}
        {room.canManage && (
          <button
            type="button"
            class="voice-room-edit"
            aria-label={`Edit voice channel ${room.name}`}
            title="Edit channel"
            onClick={(e) => {
              e.stopPropagation();
              setVoiceUi({ dialog: { kind: 'edit', host, roomId: room.id }, roomMenu: null });
            }}
          >
            <Settings size={13} aria-hidden="true" />
          </button>
        )}
      </div>
      {live.length > 0 && (
        <button
          type="button"
          class="voice-faces"
          aria-expanded={showList}
          disabled={inThis}
          aria-label={`${live.length} in call: ${showList ? 'hide' : 'show'} who's in ${room.name}`}
          title={live.map((p) => p.name).join(', ')}
          onClick={() => setPeek(!peek)}
        >
          <span class="voice-faces-stack">
            {faces.map(({ p }) => (
              <span key={`${p.sessionId}:${p.userId}`} class="voice-face" data-speaking={p.speaking || undefined}>
                <Avatar nick={p.name} url={avatarFor?.(p.name)} size={narrow ? 24 : 20} />
              </span>
            ))}
          </span>
          {more > 0 && <span class="voice-faces-more">+{more}</span>}
          {!inThis && <ChevronDown size={11} class="voice-faces-chevron" data-open={showList || undefined} aria-hidden="true" />}
        </button>
      )}
      </div>
      {showList && live.length > 0 && (
        <ul class="voice-participants" aria-label={`In ${room.name}`}>
          {listed.map(({ p, screen, camera }) => (
            <VoiceParticipantRow
              key={`${p.sessionId}:${p.userId}`}
              p={p}
              self={!!(p as VoiceParticipant).self}
              listener={!!(p as VoiceParticipant).listener}
              screen={screen}
              camera={camera}
              url={avatarFor?.(p.name)}
              onMenu={(x, y) => setVoiceUi({ userMenu: { p, x, y }, roomMenu: null })}
            />
          ))}
          {!all && hidden > 0 && (
            <li class="voice-see-all-row">
              <button type="button" class="voice-see-all" onClick={seeAll}>+{hidden} more · see all</button>
            </li>
          )}
        </ul>
      )}
    </div>
  );
}

function VoiceParticipantRow({ p, self, listener, screen, camera, url, onMenu }: {
  p: VoiceRoomParticipant;
  self: boolean;
  listener: boolean;
  screen?: boolean; // sharing their screen (known in your call)
  camera?: boolean;
  url?: string;
  onMenu: (x: number, y: number) => void;
}) {
  const guest = isGuestParticipant(p);
  const state = [guest ? 'guest' : '', p.speaking ? 'speaking' : '', screen ? 'sharing their screen' : '', camera ? 'camera on' : '', listener ? 'listening' : p.muted ? 'muted' : '', p.deafened ? 'deafened' : ''].filter(Boolean).join(', ');
  return (
    <li
      class={`voice-participant ${p.speaking ? 'voice-participant-speaking' : ''} ${self ? 'voice-participant-self' : ''}`}
      title={self ? `${p.name} (you)${listener ? ', listening' : ''}` : `${p.name} — right-click for volume`}
      aria-label={`${p.name}${self ? ' (you)' : ''}${state ? `: ${state}` : ''}`}
      onContextMenu={(e) => {
        if (self || !p.userId) return;
        e.preventDefault();
        onMenu(e.clientX, e.clientY);
      }}
    >
      <span class="voice-avatar" data-speaking={p.speaking || undefined}>
        <Avatar nick={p.name} url={url} size={20} />
      </span>
      <span class="voice-participant-name">{p.name}</span>
      {guest && <GuestBadge />}
      {screen && <span class="voice-live" aria-hidden="true">LIVE</span>}
      {camera && <Video size={12} class="voice-participant-cam" aria-hidden="true" />}
      {p.deafened ? (
        <HeadphoneOff size={13} class="voice-participant-flag" aria-label="deafened" />
      ) : listener ? (
        <span class="voice-participant-listening" aria-label="listening">listening</span>
      ) : p.muted ? (
        <MicOff size={13} class="voice-participant-flag" aria-label="muted" />
      ) : null}
    </li>
  );
}

// ---- a text channel's voice channels ----

// The voice channels under one IRC channel in the channel list.
export function ChannelVoiceRooms({ host, serverName, channel, avatarFor }: {
  host: string;
  serverName: string;
  channel: string;
  avatarFor?: (nick: string) => string | undefined;
}) {
  const { voice, snap, key, server } = useVoiceServer(host);
  if (!voice || !server || server.discovery !== 'available' || !server.rooms) return null;
  const rooms = roomsUnder(server.rooms, channel);
  if (rooms.length === 0) return null;
  return (
    <div class="voice-channel-group" aria-label={`Voice channels in ${channel}`}>
      {rooms.map((r) => (
        <VoiceRoomRow key={r.id} voice={voice} snap={snap} host={key} server={server} room={r} serverName={serverName} nested avatarFor={avatarFor} />
      ))}
    </div>
  );
}

// The "+" on a text channel's row: a voice channel under it.
export function ChannelVoiceAdd({ host, channel }: { host: string; channel: string }) {
  const { voice, key, server } = useVoiceServer(host);
  if (!voice || !server || server.discovery !== 'available' || !canCreateUnder(server.permissions, channel)) return null;
  return (
    <button
      type="button"
      class="channel-voice-add"
      aria-label={`Create a voice channel in ${channel}`}
      title={`Create a voice channel in ${channel}`}
      onClick={(e) => {
        e.stopPropagation();
        setVoiceUi({ dialog: { kind: 'create', host: key, parent: channel.toLowerCase() } });
      }}
    >
      <Plus size={13} aria-hidden="true" />
    </button>
  );
}

// ---- right-click menus ----

function useDismiss(ref: { current: HTMLElement | null }, onClose: () => void): void {
  useLayoutEffect(() => {
    const onDown = (e: MouseEvent): void => {
      if (ref.current && e.target instanceof Node && ref.current.contains(e.target)) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [onClose]);
}

// Right-click a voice channel you manage: edit, move, delete.
export function VoiceRoomMenu({ voice, host, room, x, y, onClose }: {
  voice: VoiceController;
  host: string;
  room: VoiceRoom;
  x: number;
  y: number;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useDismiss(ref, onClose);
  const move = async (dir: -1 | 1): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await voice.moveRoom(host, room.id, dir);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };
  const W = 220;
  const left = Math.max(8, Math.min(x, window.innerWidth - W - 8));
  const top = Math.max(8, Math.min(y, window.innerHeight - 200));
  const edit = (confirmDelete: boolean): void => {
    setVoiceUi({ roomMenu: null, dialog: { kind: 'edit', host, roomId: room.id, confirmDelete } });
  };
  return createPortal(
    <div ref={ref} class="nick-context-menu voice-room-menu" role="menu" aria-label={`${room.name} options`} style={`top:${top}px;left:${left}px;width:${W}px`}>
      <div class="nick-context-menu-title">{room.name}</div>
      <button type="button" role="menuitem" class="nick-context-menu-item" onClick={() => edit(false)} autoFocus>Edit channel…</button>
      <button type="button" role="menuitem" class="nick-context-menu-item" disabled={busy || !voice.canMove(host, room.id, -1)} onClick={() => { void move(-1); }}>Move up</button>
      <button type="button" role="menuitem" class="nick-context-menu-item" disabled={busy || !voice.canMove(host, room.id, 1)} onClick={() => { void move(1); }}>Move down</button>
      <div class="nick-context-menu-divider" role="separator" />
      <button type="button" role="menuitem" class="nick-context-menu-item nick-context-menu-item-danger" onClick={() => edit(true)}>Delete channel</button>
      {error && <div class="voice-room-menu-error" role="alert">{error}</div>}
    </div>,
    document.body,
  );
}

// Right-click someone in voice: their playback volume (0–200 %),
// remembered for that account.
export function VoiceUserMenu({ voice, participant, x, y, onClose }: {
  voice: VoiceController;
  participant: VoiceRoomParticipant;
  x: number;
  y: number;
  onClose: () => void;
}) {
  const [volume, setVolume] = useState(() => voice.userVolume(participant.userId));
  const ref = useRef<HTMLDivElement>(null);
  useDismiss(ref, onClose);
  const set = (v: number): void => {
    setVolume(v);
    voice.setUserVolume(participant.userId, v);
  };
  const W = 220;
  const left = Math.max(8, Math.min(x, window.innerWidth - W - 8));
  const top = Math.max(8, Math.min(y, window.innerHeight - 120));
  return createPortal(
    <div ref={ref} class="nick-context-menu voice-user-menu" role="dialog" aria-label={`${participant.name}'s volume`} style={`top:${top}px;left:${left}px;width:${W}px`}>
      <div class="nick-context-menu-title">{participant.name}</div>
      <label class="voice-user-menu-row">
        <span class="voice-user-menu-label">User volume</span>
        <span class="voice-user-menu-value">{volume}%</span>
      </label>
      <input
        type="range"
        class="voice-range"
        min={0}
        max={200}
        step={5}
        value={volume}
        aria-label={`Volume for ${participant.name}`}
        onInput={(e) => set(Number((e.target as HTMLInputElement).value))}
        autoFocus
      />
      <button type="button" class="nick-context-menu-item" disabled={volume === 100} onClick={() => set(100)}>Reset to 100%</button>
    </div>,
    document.body,
  );
}
