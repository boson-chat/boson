import { useState } from 'preact/hooks';
import { Phone, Video, X } from 'lucide-preact';
import { Button, EmptyState, Input, ListRow, PageHeader, Tabs, Toggle } from '@boson/shared';
import { Avatar } from '../../shared/Avatar/Avatar';
import { useFriends, type Friend } from '../../modules/friends';
import './FriendsView.css';

type Tab = 'all' | 'pending' | 'blocked';

interface Props {
  // phone: the Friends tab (bottom bar); desktop: the MY page.
  layout: 'desktop' | 'phone';
}

// Friends: everyone you're friends with (call, video, "Can call me
// anytime", remove), pending requests (accept / decline, cancel yours) and
// the people you blocked, plus "Add a friend by handle".
export function FriendsView({ layout }: Props) {
  const { friends, snap } = useFriends();
  const [tab, setTab] = useState<Tab>('all');
  const [handle, setHandle] = useState('');
  const [sending, setSending] = useState(false);
  const phone = layout === 'phone';
  if (!friends || !snap.available) {
    return (
      <main class={`friends friends-${layout}`}>
        <EmptyState>Sign in to your Boson account to add friends and call them.</EmptyState>
      </main>
    );
  }
  const size = phone ? 'lg' : 'md';
  const avatar = phone ? 40 : 36;
  const pending = [...snap.incoming.map((f) => ({ f, incoming: true })), ...snap.outgoing.map((f) => ({ f, incoming: false }))];
  const send = async (e: Event): Promise<void> => {
    e.preventDefault();
    if (!handle.trim()) { (document.getElementById(`friends-add-${layout}`) as HTMLInputElement | null)?.focus(); return; }
    if (sending) return;
    setSending(true);
    const ok = await friends.sendRequest(handle);
    setSending(false);
    if (ok) setHandle('');
  };
  const tabs: Array<{ id: Tab; label: string }> = [
    { id: 'all', label: `${phone ? 'FRIENDS' : 'ALL'} · ${snap.friends.length}` },
    { id: 'pending', label: `PENDING · ${snap.incoming.length}` },
    { id: 'blocked', label: phone ? 'BLOCKED' : `BLOCKED · ${snap.blocked.length}` },
  ];
  const tabList = (
    <div class="friends-tabs">
      <Tabs tabs={tabs} active={tab} onChange={(id) => setTab(id as Tab)} label="Friends" />
    </div>
  );
  const add = (
    <form class="friends-add" onSubmit={send}>
      <label for={`friends-add-${layout}`} class="friends-sr">Add a friend by handle</label>
      <span class="friends-add-field">
        <Input
          id={`friends-add-${layout}`}
          placeholder="Add a friend by handle"
          autocomplete="off"
          autocapitalize="off"
          spellcheck={false}
          value={handle}
          onInput={(e) => setHandle((e.target as HTMLInputElement).value)}
        />
      </span>
      <Button type="submit" variant="primary" size={phone ? 'lg' : 'sm'} loading={sending}>
        {phone ? 'Add' : 'Send request'}
      </Button>
    </form>
  );
  return (
    <main class={`friends friends-${layout}`} aria-label="Friends">
      {phone ? (
        <>{add}{tabList}</>
      ) : (
        <PageHeader title="Friends" actions={add} class="friends-head">{tabList}</PageHeader>
      )}
      <div class="friends-list" role="tabpanel">
        {tab === 'all' && (
          <>
            {snap.friends.map((f) => <FriendRow key={f.userId} f={f} phone={phone} />)}
            {snap.loaded && snap.friends.length === 0 && (
              <EmptyState>No friends yet. Add someone by their handle, or {phone ? 'tap' : 'right-click'} a name in Members.</EmptyState>
            )}
            {snap.friends.length > 0 && (
              <p class="friends-note">“Can call me anytime” lets that friend through even when you're on Do not disturb or calls are set to Nobody. Off, they can call you when your settings allow it (by default, friends can). To stop someone calling, remove or block them.</p>
            )}
          </>
        )}
        {tab === 'pending' && (
          <>
            {pending.map(({ f, incoming }) => (
              <ListRow
                key={f.userId}
                size={size}
                leading={<Avatar nick={f.username} accountUrl={f.avatarUrl} size={avatar} />}
                title={f.username}
                subtitle={incoming ? 'wants to be your friend' : phone ? 'request sent' : 'request sent, waiting'}
                trailing={incoming ? (
                  phone ? (
                    <>
                      <Button variant="secondary" tone="danger" size="lg" icon={<X />} aria-label={`Decline ${f.username}`}
                        onClick={() => { void friends.deleteRequest(f); }} />
                      <Button variant="success" size="lg" onClick={() => { void friends.acceptRequest(f); }}>Accept</Button>
                    </>
                  ) : (
                    <>
                      <Button variant="success" onClick={() => { void friends.acceptRequest(f); }}>Accept</Button>
                      <Button variant="secondary" onClick={() => { void friends.deleteRequest(f); }}>Decline</Button>
                    </>
                  )
                ) : (
                  <Button variant="secondary" size={size} onClick={() => { void friends.deleteRequest(f); }}>Cancel</Button>
                )}
              />
            ))}
            {pending.length === 0 && <EmptyState>No pending requests.</EmptyState>}
          </>
        )}
        {tab === 'blocked' && (
          <>
            {snap.blocked.map((f) => (
              <ListRow
                key={f.userId}
                size={size}
                leading={<Avatar nick={f.username} accountUrl={f.avatarUrl} size={avatar} dim />}
                title={f.username}
                subtitle={phone ? undefined : "Can't call you or send you friend requests. They aren't told."}
                trailing={<Button variant="secondary" size={size} onClick={() => { void friends.unblock(f); }}>Unblock</Button>}
              />
            ))}
            {snap.blocked.length === 0 && <EmptyState>Nobody blocked.</EmptyState>}
          </>
        )}
      </div>
    </main>
  );
}

function FriendRow({ f, phone }: { f: Friend; phone: boolean }) {
  const { friends } = useFriends();
  if (!friends) return null;
  const size = phone ? 'lg' : 'md';
  const sw = (
    <Toggle checked={f.canCallAnytime} onChange={(on) => { void friends.setAnytime(f, on); }}
      label={phone ? undefined : 'Can call me anytime'} ariaLabel={`${f.username} can call me anytime`} />
  );
  const calls = (
    <>
      <Button variant="secondary" tone="success" size={size} icon={<Phone />} aria-label={`Call ${f.username}`}
        onClick={() => { void friends.call(f.username, false); }} />
      <Button variant="secondary" tone="success" size={size} icon={<Video />} aria-label={`Video call ${f.username}`}
        onClick={() => { void friends.call(f.username, true); }} />
    </>
  );
  const sub = f.displayName && f.displayName !== f.username ? f.displayName : 'Friend';
  const avatar = <Avatar nick={f.username} accountUrl={f.avatarUrl} size={phone ? 40 : 36} />;
  if (phone) {
    return (
      <ListRow size="lg" leading={avatar} title={f.username} subtitle={sub} trailing={calls}>
        <div class="friends-row-anytime">
          <span class="friends-anytime-label" aria-hidden="true">Can call me anytime</span>
          {sw}
        </div>
        <div class="friends-row-remove">
          <Button variant="ghost" tone="danger" size="lg" class="friends-remove" aria-label={`Remove ${f.username} from friends`}
            onClick={() => { void friends.removeFriend(f); }}>Remove friend</Button>
        </div>
      </ListRow>
    );
  }
  return (
    <ListRow
      leading={avatar}
      title={f.username}
      subtitle={sub}
      trailing={(
        <>
          <span class="friends-anytime">{sw}</span>
          {calls}
          <Button variant="ghost" aria-label={`Remove ${f.username} from friends`}
            onClick={() => { void friends.removeFriend(f); }}>Remove</Button>
        </>
      )}
    />
  );
}
