import type { ComponentChildren } from 'preact';
import { useEffect } from 'preact/hooks';
import { Phone, Settings, Users } from 'lucide-preact';
import { Button, Count, EmptyState, ListRow, PageHeader, StatusDot } from '@boson/shared';
import { Avatar } from '../../shared/Avatar/Avatar';
import { useFriends } from '../../modules/friends';
import { useVoice } from '../../modules/voice';
import { getAvatar } from '../../modules/chat/avatar-cache';
import { isPrivateCall, openCall } from '../ChatLayout/call-shared';
import { MissedList } from './MissedCalls';
import { useNarrow, useNoTitleBar } from '../../shared/narrow';
import { openUserSettings } from '../../modules/ui/open-settings';
import { openMy, type MyView } from './friends-ui';
import './MySpace.css';

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
  // Direct messages with unread messages (MY's list).
  unreadDms?: number;
}

// The rail's MY tile: your own picture (rounded like every avatar) with a
// presence dot. Its badge counts what MY's own list marks: friend
// requests, missed calls and unread direct messages (the bell counts
// everything; a server's tile, its mentions and DMs).
export function MyRailTile({ nick, avatarUrl, presence, active, onClick, unreadDms = 0 }: RailTileProps) {
  const { pending, missed } = useMyBadge();
  const n = pending + missed + unreadDms;
  const parts = [
    pending > 0 ? `${pending} friend request${pending === 1 ? '' : 's'}` : '',
    missed > 0 ? `${missed} missed call${missed === 1 ? '' : 's'}` : '',
    unreadDms > 0 ? `${unreadDms} unread direct message${unreadDms === 1 ? '' : 's'}` : '',
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
      <StatusDot status={presence} size={12} ring class="my-tile-dot" />
      <Count value={n} overlay class="my-tile-badge" />
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
  const size = useNarrow() ? 'lg' : 'md';
  const noTitleBar = useNoTitleBar();
  return (
    <aside class="channel-sidebar my-sidebar" aria-label="You" style={width ? { width: `${width}px` } : undefined}>
      <div class="channel-sidebar-header my-sidebar-header">
        <div class="channel-sidebar-heading">
          <div class="channel-sidebar-title sidebar-server-name">{nick || 'You'}</div>
          <div class="sidebar-server-meta">
            <StatusDot status={presence} />
            <span class="sidebar-server-version">{PRESENCE_LABEL[presence]}</span>
          </div>
        </div>
      </div>
      <nav class="channel-list my-list" aria-label="Friends, calls and messages">
        <div class="my-top">
          {/* Phones have no top bar (its avatar opened settings): here. */}
          {noTitleBar && (
            <ListRow variant="nav" size={size} class="my-row my-settings" ariaLabel="Settings"
              onClick={() => openUserSettings()}
              leading={<Settings size={16} aria-hidden="true" />} title="Settings" />
          )}
          <ListRow variant="nav" size={size} class="my-row" selected={view === 'friends'}
            ariaLabel={pending > 0 ? `Friends, ${pending} request${pending === 1 ? '' : 's'}` : 'Friends'}
            onClick={() => openMy('friends')}
            leading={<Users size={16} aria-hidden="true" />} title="Friends"
            trailing={<Count value={pending} />} />
          <ListRow variant="nav" size={size} class="my-row" selected={view === 'calls'}
            ariaLabel={missed > 0 ? `Calls, ${missed} missed` : 'Calls'}
            onClick={() => openMy('calls')}
            leading={<Phone size={16} aria-hidden="true" />} title="Calls"
            trailing={<Count value={missed} tone="danger" />} />
        </div>
        <div class="channel-section-header">
          <div class="channel-section">Direct Messages</div>
        </div>
        {dms.length === 0 && <div class="channel-empty my-empty">No direct messages yet.</div>}
        {dms.map((d) => {
          const on = view === 'chat' && activeDm?.serverId === d.serverId && activeDm.name === d.name;
          const unread = !on && d.unread > 0;
          return (
            <ListRow key={`${d.serverId}\0${d.name}`} variant="nav" size={size} class="my-row" selected={on} unread={unread}
              ariaLabel={`${d.name}${showServer ? ` on ${d.serverName}` : ''}${unread ? `, ${d.unread} unread` : ''}`}
              onClick={() => onOpenDm(d)}
              leading={<Avatar nick={d.name} url={getAvatar(d.serverId, d.name)} size={20} />}
              title={d.name}
              aside={showServer ? d.serverName : undefined}
              trailing={unread ? (d.mentions > 0 ? <Count value={d.mentions} /> : <StatusDot status="unread" />) : undefined} />
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
  const size = phone ? 'lg' : 'md';
  const liveDot = <span class="calls-live-lead"><StatusDot status="live" size={10} /></span>;
  return (
    <main class={`calls-view calls-view-${layout}`} aria-label="Calls">
      {!phone && <PageHeader title="Calls" sub="live · recent" />}
      <div class="calls-view-body">
        {settings}
        {privateCall && (
          <section aria-labelledby="calls-now">
            <h2 id="calls-now" class="calls-sec">IN A CALL</h2>
            <ListRow size={size} leading={liveDot} titleTone="success"
              title={snap.active ? `Call with ${snap.active.call.peer.username}` : 'Private call'}
              subtitle="private · 1:1"
              trailing={<Button variant="secondary" tone="success" size={size} onClick={openCall}>Open</Button>} />
          </section>
        )}
        <section aria-labelledby="calls-live">
          <h2 id="calls-live" class="calls-sec">LIVE NOW</h2>
          {live.length === 0 && <EmptyState>No one is in a voice channel right now.</EmptyState>}
          {live.map((r) => {
            const server = serverNameFor(r.host);
            return (
              <ListRow key={`${r.host}\0${r.id}`} size={size} leading={liveDot} titleTone="success"
                title={`${r.name}${server ? ` · ${server}` : ''}`}
                subtitle={peopleText(r.people)}
                trailing={r.here ? (
                  <Button variant="secondary" tone="success" size={size} onClick={openCall}
                    aria-label={`Open the call in ${r.name}`}>Open</Button>
                ) : (
                  <Button variant="secondary" tone="success" size={size} onClick={() => onJoin(r.host, r.id, r.name)}
                    aria-label={`Join ${r.name}${server ? ` on ${server}` : ''}`}>Join</Button>
                )} />
            );
          })}
        </section>
        {snap.available && (
          <section aria-labelledby="calls-recent">
            <h2 id="calls-recent" class="calls-sec">MISSED CALLS</h2>
            {snap.missedCalls.length > 0
              ? <MissedList calls={snap.missedCalls} layout={layout} />
              : <EmptyState>No missed calls.</EmptyState>}
          </section>
        )}
        {snap.available && (
          <Button variant="ghost" size={phone ? 'lg' : 'sm'} class="calls-privacy" onClick={() => openUserSettings('privacy')}>
            Privacy &amp; calls: who can call you, Do not disturb
            <span aria-hidden="true"> →</span>
          </Button>
        )}
      </div>
    </main>
  );
}

function peopleText(names: readonly string[]): string {
  if (names.length <= 3) return names.join(', ');
  return `${names.slice(0, 3).join(', ')} and ${names.length - 3} more`;
}
