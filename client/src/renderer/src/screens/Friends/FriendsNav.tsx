import { useEffect } from 'preact/hooks';
import { MessageSquare, Phone, Users } from 'lucide-preact';
import { useFriends } from '../../modules/friends';
import { FriendsView } from './FriendsView';
import { PrivacyCalls } from './PrivacyCalls';
import { MissedList } from './MissedCalls';
import { setFriendsUi, useFriendsUi } from './friends-ui';
import './FriendsNav.css';

const count = (n: number): string => (n > 99 ? '99+' : String(n));

// Desktop: the rail's MY tile (Friends), with the pending-requests count.
export function FriendsRailTile({ active }: { active: boolean }) {
  const { snap } = useFriends();
  const pending = snap.incoming.length;
  return (
    <button
      type="button"
      class={`server-item friends-rail-tile${active ? ' server-item-active friends-rail-tile-active' : ''}`}
      aria-label={pending > 0 ? `Friends (${pending} pending)` : 'Friends'}
      aria-current={active ? 'true' : undefined}
      title="Friends"
      onClick={() => setFriendsUi({ page: true })}
    >
      MY
      {pending > 0 && <span class="friends-rail-badge" aria-hidden="true">{count(pending)}</span>}
    </button>
  );
}

// Phones: the bottom bar (Chats, Friends, Calls).
export function PhoneTabBar() {
  const { snap } = useFriends();
  const { tab } = useFriendsUi();
  const pending = snap.incoming.length;
  const tabs = [
    { id: 'chats' as const, label: 'Chats', icon: <MessageSquare size={22} aria-hidden="true" />, badge: 0, cls: '' },
    { id: 'friends' as const, label: 'Friends', icon: <Users size={22} aria-hidden="true" />, badge: pending, cls: 'phone-tab-badge-pending' },
    { id: 'calls' as const, label: 'Calls', icon: <Phone size={22} aria-hidden="true" />, badge: snap.missed, cls: 'phone-tab-badge-missed' },
  ];
  return (
    <nav class="phone-tabs" aria-label="App">
      {tabs.map((t) => (
        <button key={t.id} type="button" class={`phone-tab${tab === t.id ? ' phone-tab-on' : ''}`}
          aria-current={tab === t.id ? 'page' : undefined}
          aria-label={t.badge > 0 ? `${t.label} (${t.badge})` : t.label}
          onClick={() => setFriendsUi({ tab: t.id })}>
          {t.icon}
          <span>{t.label}</span>
          {t.badge > 0 && <span class={`phone-tab-badge ${t.cls}`} aria-hidden="true">{count(t.badge)}</span>}
        </button>
      ))}
    </nav>
  );
}

// Phones: the Calls tab — missed calls, then Privacy & calls. Opening it
// marks missed calls seen (the badge clears).
export function CallsPage() {
  const { friends, snap } = useFriends();
  useEffect(() => { void friends?.seeMissed(); }, [friends]);
  return (
    <main class="calls-page" aria-label="Calls">
      <h1 class="calls-page-title">Privacy &amp; calls</h1>
      {snap.missedCalls.length > 0 && (
        <section class="calls-page-missed">
          <span class="calls-page-label">MISSED CALLS</span>
          <MissedList calls={snap.missedCalls} />
        </section>
      )}
      <PrivacyCalls layout="phone" />
    </main>
  );
}

// Phones: the Friends or Calls tab over the chats (which stay mounted).
export function PhonePage() {
  const { tab } = useFriendsUi();
  if (tab === 'friends') return <div class="phone-page"><FriendsView layout="phone" /></div>;
  if (tab === 'calls') return <div class="phone-page"><CallsPage /></div>;
  return null;
}
