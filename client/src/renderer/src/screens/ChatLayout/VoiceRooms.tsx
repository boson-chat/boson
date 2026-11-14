import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { createPortal } from 'preact/compat';
import { HeadphoneOff, Lock, MicOff, Plus, Settings, Volume2 } from 'lucide-preact';
import {
  roomsUnder, useVoice, type VoiceController, type VoiceParticipant, type VoiceRole, type VoiceRoom,
  type VoiceRoomParticipant, type VoiceRoomPermissions, type VoiceServerView,
} from '../../modules/voice';
import { Avatar } from '../../shared/Avatar/Avatar';
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

interface VoiceUiState {
  dialog: VoiceDialog | null;
  roomMenu: { host: string; roomId: string; x: number; y: number } | null;
  userMenu: { p: VoiceRoomParticipant; x: number; y: number } | null;
}

let ui: VoiceUiState = { dialog: null, roomMenu: null, userMenu: null };
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

export function VoiceRoomRow({ voice, snap, host, server, room, serverName, nested, avatarFor }: {
  voice: VoiceController;
  snap: ReturnType<typeof useVoice>['snap'];
  host: string;
  server: VoiceServerView;
  room: VoiceRoom;
  serverName: string;
  // Under a text channel (indented a step).
  nested?: boolean;
  avatarFor?: (nick: string) => string | undefined;
}) {
  const call = snap.call;
  const callHere = call.host === host && (call.status === 'connected' || call.status === 'connecting');
  const inThis = callHere && call.room === room.id;
  const locked = room.canJoin === false && !inThis;
  const listenOnly = room.canSpeak === false && !locked && !inThis;
  const joinable = server.audio && !locked;
  const live: Array<VoiceRoomParticipant & { self?: boolean; volume?: number; listener?: boolean }> =
    inThis && call.status === 'connected' && call.participants.length > 0 ? call.participants : room.participants;
  const join = (): void => { if (joinable) void voice.join(host, room, serverName); };
  const title = !server.audio ? "Voice audio isn't available in this build"
    : locked ? lockReason(room)
      : inThis ? 'Connected'
        : listenOnly ? `Join ${room.name} to listen (talking needs ${roleShort(room.speakRole)})`
          : `Join ${room.name}`;
  return (
    <div class={`voice-room ${nested ? 'voice-room-nested' : ''}`} data-room={room.id}>
      <div
        class={`channel-item voice-room-row ${inThis ? 'channel-item-active' : ''}`}
        role="button"
        tabIndex={joinable ? 0 : -1}
        aria-disabled={!joinable || undefined}
        aria-label={inThis ? `${room.name} (connected)` : locked ? `${room.name} (locked)` : `Join voice channel ${room.name}${listenOnly ? ', listen only' : ''}`}
        title={title}
        data-state={inThis ? call.status : undefined}
        data-locked={locked || undefined}
        onClick={join}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            join();
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
        {live.length > 0 && <span class="voice-room-count" aria-hidden="true">{live.length}</span>}
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
        <ul class="voice-participants" aria-label={`In ${room.name}`}>
          {live.map((p) => (
            <VoiceParticipantRow
              key={`${p.sessionId}:${p.userId}`}
              p={p}
              self={!!(p as VoiceParticipant).self}
              listener={!!(p as VoiceParticipant).listener}
              url={avatarFor?.(p.name)}
              onMenu={(x, y) => setVoiceUi({ userMenu: { p, x, y }, roomMenu: null })}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

function VoiceParticipantRow({ p, self, listener, url, onMenu }: {
  p: VoiceRoomParticipant;
  self: boolean;
  listener: boolean;
  url?: string;
  onMenu: (x: number, y: number) => void;
}) {
  const state = [p.speaking ? 'speaking' : '', listener ? 'listening' : p.muted ? 'muted' : '', p.deafened ? 'deafened' : ''].filter(Boolean).join(', ');
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
