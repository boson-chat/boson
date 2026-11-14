import { useCallback, useEffect, useRef } from 'preact/hooks';
import type { EngineState } from '../../modules/engine';
import { useAuthState } from '../../modules/auth';
import { type VoiceRoom } from '../../modules/voice';
import {
  VoiceRoomMenu, VoiceRoomRow, VoiceUserMenu, canCreateUnder, setVoiceUi, useVoiceServer, useVoiceUi,
} from './VoiceRooms';
import { VoiceRoomDialog, voiceRoomOf } from './VoiceRoomDialog';
import './NickContextMenu.css';
import './VoiceSection.css';

interface VoiceSectionProps {
  // The IRC server's hostname (voice is discovered per server).
  host: string;
  serverName: string;
  engineState?: EngineState;
  avatarFor?: (nick: string) => string | undefined;
  // The IRC channels you're in. Their voice channels show under them in
  // the channel list (ChannelVoiceRooms); the rest show here.
  channels?: readonly string[];
}

// The VOICE section under CHANNELS, Discord style: the server's voice
// channels that aren't under a text channel you're in (top-level ones, and
// those of channels you haven't joined, under that channel's name), with
// who's in each. Click a channel to join (one voice channel at a time,
// across servers); right-click one you manage to edit, move or delete it;
// right-click someone for their volume. It also owns discovery, the room
// list poll and the create/edit dialog for the whole server. Nothing at all
// for a server without voice, for guests, and outside the desktop app.
export function VoiceSection({ host, serverName, engineState, avatarFor, channels = [] }: VoiceSectionProps) {
  const { voice, snap, key, server } = useVoiceServer(host);
  const { session } = useAuthState();
  const signedIn = !!session;
  const available = !!voice && signedIn && server?.discovery === 'available';
  const ui = useVoiceUi();

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

  // Menus and dialogs belong to the server they were opened on.
  useEffect(() => () => setVoiceUi({ dialog: null, roomMenu: null, userMenu: null }), [key]);
  const closeDialog = useCallback(() => setVoiceUi({ dialog: null }), []);
  const closeRoomMenu = useCallback(() => setVoiceUi({ roomMenu: null }), []);
  const closeUserMenu = useCallback(() => setVoiceUi({ userMenu: null }), []);

  if (!voice || !available || !server) return null;

  const joined = channels.filter((c) => /^[#&]/.test(c)).map((c) => c.toLowerCase());
  const call = snap.call;
  const callHere = call.host === key && (call.status === 'connected' || call.status === 'connecting');
  const all: VoiceRoom[] = [...(server.rooms ?? [])];
  // The room we're in shows even before (or without) the room list.
  if (callHere && call.room && !all.some((r) => r.id === call.room)) {
    all.unshift({ id: call.room, name: call.roomName || call.room, participants: [] });
  }
  // Here: top-level rooms, then rooms of channels you aren't in, by channel.
  const topLevel = all.filter((r) => !r.parent);
  const orphans = new Map<string, VoiceRoom[]>();
  for (const r of all) {
    const p = (r.parent ?? '').toLowerCase();
    if (!p || joined.includes(p)) continue;
    orphans.set(p, [...(orphans.get(p) ?? []), r]);
  }
  const shown = topLevel.length + [...orphans.values()].reduce((n, rs) => n + rs.length, 0);
  const anyRooms = all.length > 0;
  const perms = server.permissions;
  // "+" here: top level, or (founders) a founded channel that isn't joined.
  const canAddHere = canCreateUnder(perms, '')
    || (perms.createScope === 'founded_channels' && (perms.foundedChannels ?? []).length > 0);
  const isAdmin = session?.user.role === 'admin' || session?.user.role === 'moderator';

  const menuRoom = ui.roomMenu && ui.roomMenu.host === key ? voiceRoomOf(server, ui.roomMenu.roomId) : null;

  return (
    <section class="voice-section" aria-label="Voice channels">
      <div class="channel-section-header">
        <div class="channel-section">Voice</div>
        {canAddHere && (
          <button
            type="button"
            class="channel-add"
            aria-label="Create a voice channel"
            title="Create a voice channel"
            onClick={() => setVoiceUi({ dialog: { kind: 'create', host: key, parent: null } })}
          >
            +
          </button>
        )}
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
      {server.rooms === null && !server.roomsError && !anyRooms && (
        <div class="voice-note" aria-busy="true">Loading voice channels…</div>
      )}
      {server.rooms !== null && !anyRooms && !server.roomsError && (
        <div class="voice-note">{perms.canCreate ? 'No voice channels yet. Use + to make one.' : 'No voice channels yet.'}</div>
      )}
      {anyRooms && shown === 0 && !server.roomsError && (
        <div class="voice-note">Voice channels are under their text channels.</div>
      )}
      {topLevel.map((r) => (
        <VoiceRoomRow key={r.id} voice={voice} snap={snap} host={key} server={server} room={r} serverName={serverName} avatarFor={avatarFor} />
      ))}
      {[...orphans.entries()].map(([parent, rooms]) => (
        <div key={parent} class="voice-orphan-group" aria-label={`Voice channels in ${parent}`}>
          <div class="voice-orphan-parent" title={`You're not in ${parent}`}>{parent}</div>
          {rooms.map((r) => (
            <VoiceRoomRow key={r.id} voice={voice} snap={snap} host={key} server={server} room={r} serverName={serverName} nested avatarFor={avatarFor} />
          ))}
        </div>
      ))}
      {ui.dialog && ui.dialog.host === key && (
        <VoiceRoomDialog
          key={ui.dialog.kind === 'edit' ? `edit:${ui.dialog.roomId}:${ui.dialog.confirmDelete ? 'd' : ''}` : `create:${ui.dialog.parent ?? ''}`}
          voice={voice}
          dialog={ui.dialog}
          server={server}
          joinedChannels={joined}
          isNetworkAdmin={isAdmin}
          onClose={closeDialog}
        />
      )}
      {ui.roomMenu && menuRoom && (
        <VoiceRoomMenu voice={voice} host={key} room={menuRoom} x={ui.roomMenu.x} y={ui.roomMenu.y} onClose={closeRoomMenu} />
      )}
      {ui.userMenu && (
        <VoiceUserMenu voice={voice} participant={ui.userMenu.p} x={ui.userMenu.x} y={ui.userMenu.y} onClose={closeUserMenu} />
      )}
    </section>
  );
}
