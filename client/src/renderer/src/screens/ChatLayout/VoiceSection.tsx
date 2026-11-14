import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { createPortal } from 'preact/compat';
import { HeadphoneOff, MicOff, Volume2 } from 'lucide-preact';
import type { EngineState } from '../../modules/engine';
import { useAuthState } from '../../modules/auth';
import {
  useVoice, type VoiceController, type VoiceParticipant, type VoiceRoom, type VoiceRoomParticipant,
} from '../../modules/voice';
import { Avatar } from '../../shared/Avatar/Avatar';
import './NickContextMenu.css';
import './VoiceSection.css';

interface VoiceSectionProps {
  // The IRC server's hostname (voice is discovered per server).
  host: string;
  serverName: string;
  engineState?: EngineState;
  avatarFor?: (nick: string) => string | undefined;
}

// The VOICE section under CHANNELS, Discord style: a server's voice channels
// with who's in each, speaking rings and mute/deafen icons. Click a channel
// to join (one voice channel at a time, across servers); right-click someone
// for their volume. Nothing at all for a server without voice, for guests,
// and outside the desktop app.
export function VoiceSection({ host, serverName, engineState, avatarFor }: VoiceSectionProps) {
  const { voice, snap } = useVoice();
  const { session } = useAuthState();
  const signedIn = !!session;
  const key = host.trim().toLowerCase();
  const server = snap.servers[key];
  const available = !!voice && signedIn && server?.discovery === 'available';

  // Discover once per server; again (re-check) on every reconnect.
  const wasConnected = useRef(engineState === 'connected');
  useEffect(() => {
    if (!voice || !signedIn || !key) return;
    void voice.discover(key);
  }, [voice, signedIn, key]);
  useEffect(() => {
    const connected = engineState === 'connected';
    if (connected && !wasConnected.current && voice && signedIn && key) void voice.discover(key, true);
    wasConnected.current = connected;
  }, [engineState, voice, signedIn, key]);

  // Poll the room list while this panel shows it.
  useEffect(() => {
    if (!voice || !available) return;
    return voice.watchRooms(key);
  }, [voice, available, key]);

  const [menu, setMenu] = useState<{ p: VoiceRoomParticipant; x: number; y: number } | null>(null);

  if (!voice || !available || !server) return null;

  const call = snap.call;
  const callHere = call.host === key && (call.status === 'connected' || call.status === 'connecting');
  const rooms: VoiceRoom[] = [...(server.rooms ?? [])];
  // The room we're in shows even before (or without) the room list.
  if (callHere && call.room && !rooms.some((r) => r.id === call.room)) {
    rooms.unshift({ id: call.room, name: call.roomName || call.room, participants: [] });
  }

  return (
    <section class="voice-section" aria-label="Voice channels">
      <div class="channel-section-header">
        <div class="channel-section">Voice</div>
      </div>
      {!server.audio && (
        <div class="voice-note" role="note">Voice audio isn't available in this build.</div>
      )}
      {server.roomsError && (
        <div class="voice-note voice-note-error" role="status">
          <span>{server.roomsError}</span>
          <button type="button" class="voice-note-retry" onClick={() => { void voice.refreshRooms(key, true); }}>Retry</button>
        </div>
      )}
      {server.rooms === null && !server.roomsError && rooms.length === 0 && (
        <div class="voice-note" aria-busy="true">Loading voice channels…</div>
      )}
      {server.rooms !== null && rooms.length === 0 && !server.roomsError && (
        <div class="voice-note">No voice channels yet.</div>
      )}
      {rooms.map((r) => {
        const inThis = callHere && call.room === r.id;
        const live: Array<VoiceRoomParticipant & { self?: boolean; volume?: number }> =
          inThis && call.status === 'connected' && call.participants.length > 0 ? call.participants : r.participants;
        return (
          <div key={r.id} class="voice-room">
            <div
              class={`channel-item voice-room-row ${inThis ? 'channel-item-active' : ''}`}
              role="button"
              tabIndex={server.audio ? 0 : -1}
              aria-disabled={!server.audio || undefined}
              aria-label={inThis ? `${r.name} (connected)` : `Join voice channel ${r.name}`}
              title={!server.audio ? "Voice audio isn't available in this build" : inThis ? 'Connected' : `Join ${r.name}`}
              data-state={inThis ? call.status : undefined}
              onClick={() => { if (server.audio) void voice.join(key, r, serverName); }}
              onKeyDown={(e) => {
                if ((e.key === 'Enter' || e.key === ' ') && server.audio) {
                  e.preventDefault();
                  void voice.join(key, r, serverName);
                }
              }}
            >
              <span class="channel-hash voice-room-icon">
                {inThis && call.status === 'connecting'
                  ? <span class="channel-sync-spinner" data-sync="loading" aria-hidden="true" />
                  : <Volume2 size={14} aria-hidden="true" />}
              </span>
              <span class="channel-name">{r.name}</span>
              {live.length > 0 && <span class="voice-room-count" aria-hidden="true">{live.length}</span>}
            </div>
            {live.length > 0 && (
              <ul class="voice-participants" aria-label={`In ${r.name}`}>
                {live.map((p) => (
                  <VoiceParticipantRow
                    key={`${p.sessionId}:${p.userId}`}
                    p={p}
                    self={!!(p as VoiceParticipant).self}
                    url={avatarFor?.(p.name)}
                    onMenu={(x, y) => setMenu({ p, x, y })}
                  />
                ))}
              </ul>
            )}
          </div>
        );
      })}
      {menu && (
        <VoiceUserMenu
          voice={voice}
          participant={menu.p}
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
        />
      )}
    </section>
  );
}

function VoiceParticipantRow({ p, self, url, onMenu }: {
  p: VoiceRoomParticipant;
  self: boolean;
  url?: string;
  onMenu: (x: number, y: number) => void;
}) {
  const state = [p.speaking ? 'speaking' : '', p.muted ? 'muted' : '', p.deafened ? 'deafened' : ''].filter(Boolean).join(', ');
  return (
    <li
      class={`voice-participant ${p.speaking ? 'voice-participant-speaking' : ''} ${self ? 'voice-participant-self' : ''}`}
      title={self ? `${p.name} (you)` : `${p.name} — right-click for volume`}
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
      ) : p.muted ? (
        <MicOff size={13} class="voice-participant-flag" aria-label="muted" />
      ) : null}
    </li>
  );
}

// Right-click on someone in voice: their playback volume (0–200 %),
// remembered for that account.
function VoiceUserMenu({ voice, participant, x, y, onClose }: {
  voice: VoiceController;
  participant: VoiceRoomParticipant;
  x: number;
  y: number;
  onClose: () => void;
}) {
  const [volume, setVolume] = useState(() => voice.userVolume(participant.userId));
  const ref = useRef<HTMLDivElement>(null);
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
