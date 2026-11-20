import type { ComponentChildren } from 'preact';
import { MessageSquare, Phone, Users } from 'lucide-preact';
import { useFriends } from '../../modules/friends';
import { FriendsView } from './FriendsView';
import { setFriendsUi, useFriendsUi } from './friends-ui';
import './FriendsNav.css';

const count = (n: number): string => (n > 99 ? '99+' : String(n));

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

// Phones: the Friends or Calls tab over the chats (which stay mounted).
// `calls` is the Calls page (MySpace's CallsView, wired by ChatLayout).
export function PhonePage({ calls }: { calls: ComponentChildren }) {
  const { tab } = useFriendsUi();
  if (tab === 'friends') return <div class="phone-page"><FriendsView layout="phone" /></div>;
  if (tab === 'calls') return <div class="phone-page">{calls}</div>;
  return null;
}
