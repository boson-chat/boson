import type { ComponentChildren } from 'preact';
import { useEffect } from 'preact/hooks';
import { Phone, Users } from 'lucide-preact';
import { Avatar } from '../../shared/Avatar/Avatar';
import { useFriends } from '../../modules/friends';
import { useVoice } from '../../modules/voice';
import { getAvatar } from '../../modules/chat/avatar-cache';
import { isPrivateCall, openCall } from '../ChatLayout/call-shared';
import { MissedList } from './MissedCalls';
import { IncomingCallsSetting } from '../Notifications/IncomingCalls';
import { openUserSettings } from '../../modules/ui/open-settings';
import { openMy, type MyView } from './friends-ui';
import './MySpace.css';

const count = (n: number): string => (n > 99 ? '99+' : String(n));

// Your presence, as the dot on your avatar shows it.
export type Presence = 'online' | 'dnd' | 'offline';

export const PRESENCE_LABEL: Record<Presence, string> = {
  online: 'Online',
  dnd: 'Do not disturb',
  offline: 'Offline',
};

// What MY's badge counts: friend requests waiting on you, plus missed calls.
export function useMyBadge(): { pending: number; missed: number } {
  const { snap } = useFriends();
  return { pending: snap.available ? snap.incoming.length : 0, missed: snap.available ? snap.missed : 0 };
}

interface RailTileProps {
  nick: string;
  avatarUrl?: string | null;
  presence: Presence;
  active: boolean;
  onClick: () => void;
}

// The rail's MY tile: your own picture (rounded like every avatar) with a
// presence dot; the badge counts requests and missed calls.
export function MyRailTile({ nick, avatarUrl, presence, active, onClick }: RailTileProps) {
  const { pending, missed } = useMyBadge();
  const n = pending + missed;
  const parts = [
    pending > 0 ? `${pending} friend request${pending === 1 ? '' : 's'}` : '',
    missed > 0 ? `${missed} missed call${missed === 1 ? '' : 's'}` : '',
  ].filter(Boolean).join(', ');
  return (
    <button
      type="button"
      class={`my-tile${active ? ' my-tile-active' : ''}`}
      aria-label={`You: friends, calls and messages (${PRESENCE_LABEL[presence]}${parts ? `; ${parts}` : ''})`}
      aria-current={active ? 'true' : undefined}
      title="You: friends, calls and messages"
      onClick={onClick}
    >
      <Avatar nick={nick || '?'} url={avatarUrl} size={40} class="my-tile-av" />
      <span class="my-tile-dot" data-presence={presence} aria-hidden="true" />
      {n > 0 && <span class="my-tile-badge" aria-hidden="true">{count(n)}</span>}
    </button>
  );
}

// Under MY, before the servers: a thin bar marked SERVERS.
export function RailDivider() {
  return (
    <div class="rail-divider" aria-hidden="true">
      <span class="rail-divider-bar" />
      <span class="rail-divider-label">SERVERS</span>
    </div>
  );
}

// A direct message for MY's list (from any connected server).
export interface MyDm {
  serverId: string;
  serverName: string;
  name: string;
  unread: number;
  mentions: number;
}

interface SidebarProps {
  nick: string;
  presence: Presence;
  view: MyView | null;
  dms: readonly MyDm[];
  // The DM showing (serverId + name) when the view is a conversation.
  activeDm: { serverId: string; name: string } | null;
  onOpenDm: (dm: MyDm) => void;
  // More than one server: each DM says which.
  showServer: boolean;
  width?: number;
}

// MY's sidebar: Friends and Calls at the top, then your direct messages.
export function MySidebar({ nick, presence, view, dms, activeDm, onOpenDm, showServer, width }: SidebarProps) {
  const { pending, missed } = useMyBadge();
  return (
    <aside class="channel-sidebar my-sidebar" aria-label="You" style={width ? { width: `${width}px` } : undefined}>
      <div class="channel-sidebar-header my-sidebar-header">
        <div class="channel-sidebar-heading">
          <div class="channel-sidebar-title sidebar-server-name">{nick || 'You'}</div>
          <div class="sidebar-server-meta">
            <span class="my-sidebar-dot" data-presence={presence} aria-hidden="true" />
            <span class="sidebar-server-version">{PRESENCE_LABEL[presence]}</span>
          </div>
        </div>
      </div>
      <nav class="channel-list my-list" aria-label="Friends, calls and messages">
        <div class="my-top">
          <button type="button" class={`my-row${view === 'friends' ? ' my-row-on' : ''}`}
            aria-current={view === 'friends' ? 'page' : undefined}
            aria-label={pending > 0 ? `Friends, ${pending} request${pending === 1 ? '' : 's'}` : 'Friends'}
            onClick={() => openMy('friends')}>
            <Users size={16} aria-hidden="true" />
            <span class="my-row-label">Friends</span>
            {pending > 0 && <span class="my-count" aria-hidden="true">{count(pending)}</span>}
          </button>
          <button type="button" class={`my-row${view === 'calls' ? ' my-row-on' : ''}`}
            aria-current={view === 'calls' ? 'page' : undefined}
            aria-label={missed > 0 ? `Calls, ${missed} missed` : 'Calls'}
            onClick={() => openMy('calls')}>
            <Phone size={16} aria-hidden="true" />
            <span class="my-row-label">Calls</span>
            {missed > 0 && <span class="my-count my-count-missed" aria-hidden="true">{count(missed)}</span>}
          </button>
        </div>
        <div class="channel-section-header">
          <div class="channel-section">Direct Messages</div>
        </div>
        {dms.length === 0 && <div class="channel-empty my-empty">No direct messages yet.</div>}
        {dms.map((d) => {
          const on = view === 'chat' && activeDm?.serverId === d.serverId && activeDm.name === d.name;
          const unread = !on && d.unread > 0;
          return (
            <button key={`${d.serverId}\0${d.name}`} type="button"
              class={`my-row my-dm${on ? ' my-row-on' : ''}${unread ? ' my-dm-unread' : ''}`}
              aria-current={on ? 'page' : undefined}
              aria-label={`${d.name}${showServer ? ` on ${d.serverName}` : ''}${unread ? `, ${d.unread} unread` : ''}`}
              onClick={() => onOpenDm(d)}>
              <Avatar nick={d.name} url={getAvatar(d.serverId, d.name)} size={20} />
              <span class="my-row-label">{d.name}</span>
              {showServer && <span class="my-dm-server">{d.serverName}</span>}
              {unread && (d.mentions > 0
                ? <span class="my-count" aria-hidden="true">{count(d.mentions)}</span>
                : <span class="channel-unread-dot" aria-hidden="true" />)}
            </button>
          );
        })}
      </nav>
    </aside>
  );
}

interface CallsViewProps {
  layout: 'desktop' | 'phone';
  // A live voice channel's Join: go to its server and open it.
  onJoin: (host: string, roomId: string, roomName: string) => void;
  // A display name for a voice host (its server), when known.
  serverNameFor: (host: string) => string | undefined;
  // Extra settings shown above the lists (the incoming-call style).
  settings?: ComponentChildren;
}

// Calls: the call you're in, voice channels with people in them that you
// can join, then missed calls with Call back. Opening it marks missed
// calls seen (MY's badge clears).
export function CallsView({ layout, onJoin, serverNameFor, settings }: CallsViewProps) {
  const { friends, snap } = useFriends();
  const { voice: voiceCtl, snap: voice } = useVoice();
  useEffect(() => { if (snap.missed > 0) void friends?.seeMissed(); }, [friends, snap.missed]);
  // Keep every voice server's channel list fresh while this shows.
  const hosts = Object.keys(voice.servers).filter((h) => voice.servers[h]?.discovery === 'available').sort().join(' ');
  useEffect(() => {
    if (!voiceCtl || !hosts) return;
    const stops = hosts.split(' ').map((h) => voiceCtl.watchRooms(h));
    return () => stops.forEach((stop) => stop());
  }, [voiceCtl, hosts]);
  const call = voice.call;
  const inCall = (call.status === 'connected' || call.status === 'connecting') && !!call.host;
  const live: Array<{ host: string; id: string; name: string; people: string[]; here: boolean }> = [];
  for (const [host, s] of Object.entries(voice.servers)) {
    for (const r of s.rooms ?? []) {
      if (isPrivateCall(r.id) || r.participants.length === 0) continue;
      live.push({ host, id: r.id, name: r.name, people: r.participants.map((p) => p.name), here: inCall && call.host === host && call.room === r.id });
    }
  }
  const privateCall = inCall && isPrivateCall(call.room);
  const phone = layout === 'phone';
  return (
    <main class={`calls-view calls-view-${layout}`} aria-label="Calls">
      {!phone && (
        <header class="calls-view-head">
          <h1 class="calls-view-title">Calls</h1>
          <span class="calls-view-sub">live · recent</span>
        </header>
      )}
      <div class="calls-view-body">
        {settings}
        {snap.available && <IncomingCallsSetting layout={layout} />}
        {privateCall && (
          <section aria-labelledby="calls-now">
            <h2 id="calls-now" class="calls-sec">IN A CALL</h2>
            <div class="calls-row">
              <span class="calls-live-dot" aria-hidden="true">◉</span>
              <span class="calls-who">
                <span class="calls-name calls-name-live">{snap.active ? `Call with ${snap.active.call.peer.username}` : 'Private call'}</span>
                <span class="calls-sub">private · 1:1</span>
              </span>
              <button type="button" class="calls-btn calls-btn-live" onClick={openCall}>Open</button>
            </div>
          </section>
        )}
        <section aria-labelledby="calls-live">
          <h2 id="calls-live" class="calls-sec">LIVE NOW</h2>
          {live.length === 0 && <p class="calls-empty">No one is in a voice channel right now.</p>}
          {live.map((r) => {
            const server = serverNameFor(r.host);
            return (
              <div key={`${r.host}\0${r.id}`} class="calls-row">
                <span class="calls-live-dot" aria-hidden="true">◉</span>
                <span class="calls-who">
                  <span class="calls-name calls-name-live">{r.name}{server ? ` · ${server}` : ''}</span>
                  <span class="calls-sub">{peopleText(r.people)}</span>
                </span>
                {r.here ? (
                  <button type="button" class="calls-btn calls-btn-live" onClick={openCall}
                    aria-label={`Open the call in ${r.name}`}>Open</button>
                ) : (
                  <button type="button" class="calls-btn calls-btn-live" onClick={() => onJoin(r.host, r.id, r.name)}
                    aria-label={`Join ${r.name}${server ? ` on ${server}` : ''}`}>Join</button>
                )}
              </div>
            );
          })}
        </section>
        {snap.available && (
          <section aria-labelledby="calls-recent">
            <h2 id="calls-recent" class="calls-sec">MISSED CALLS</h2>
            {snap.missedCalls.length > 0
              ? <MissedList calls={snap.missedCalls} />
              : <p class="calls-empty">No missed calls.</p>}
          </section>
        )}
        {snap.available && (
          <button type="button" class="calls-privacy" onClick={() => openUserSettings('privacy')}>
            Privacy &amp; calls: who can call you, Do not disturb
            <span aria-hidden="true"> →</span>
          </button>
        )}
      </div>
    </main>
  );
}

function peopleText(names: readonly string[]): string {
  if (names.length <= 3) return names.join(', ');
  return `${names.slice(0, 3).join(', ')} and ${names.length - 3} more`;
}
