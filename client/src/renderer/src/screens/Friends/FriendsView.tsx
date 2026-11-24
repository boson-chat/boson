import { useState } from 'preact/hooks';
import { CircleHelp, Phone, Video, X } from 'lucide-preact';
import { AtomLoader, Button, ConfirmDialog, EmptyState, Input, ListRow, PageHeader, Tabs, Toggle } from '@boson/shared';
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
  // Remove friend asks first.
  const [removing, setRemoving] = useState<Friend | null>(null);
  // "Can call me anytime", explained: behind a ?, not a paragraph.
  const [help, setHelp] = useState(false);
  const phone = layout === 'phone';
  if (!friends || !snap.available) {
    // Signed out, this server's account service has no friends, or still
    // asking it: three different things to say.
    const state = !friends || !snap.signedIn ? 'signed-out' : snap.unsupported ? 'unsupported' : 'loading';
    return (
      <main class={`friends friends-${layout}`} aria-label="Friends" aria-busy={state === 'loading' || undefined}>
        {state === 'loading' ? (
          <div class="friends-loading" role="status"><AtomLoader size={20} label="Loading friends" /><span>Loading friends…</span></div>
        ) : (
          <EmptyState>{state === 'unsupported'
            ? "Friends and calls aren't available with your account's server yet."
            : 'Sign in to your Boson account to add friends and call them.'}</EmptyState>
        )}
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
  const helpNote = (
    <p class="friends-note" id={`friends-help-${layout}`}>“Can call me anytime” rings you even on Do not disturb or when calls are set to Nobody. To stop someone calling, remove or block them.</p>
  );
  const tabList = (
    <div class="friends-tabs">
      <Tabs tabs={tabs} active={tab} onChange={(id) => setTab(id as Tab)} label="Friends" />
      {!phone && tab === 'all' && snap.friends.length > 0 && (
        <Button variant="ghost" size="sm" class="friends-help-btn" pressed={help} icon={<CircleHelp aria-hidden="true" />}
          aria-label="What does Can call me anytime do?" title="What does “Can call me anytime” do?" aria-expanded={help}
          aria-controls={`friends-help-${layout}`} onClick={() => setHelp(!help)} />
      )}
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
            {!phone && help && snap.friends.length > 0 && helpNote}
            {snap.friends.map((f) => <FriendRow key={f.userId} f={f} phone={phone} onRemove={() => setRemoving(f)} />)}
            {/* Phones: the ? is a line under the list (the tabs fill the width). */}
            {phone && snap.friends.length > 0 && (help ? helpNote : (
              <Button variant="ghost" size="lg" class="friends-help-link" icon={<CircleHelp aria-hidden="true" />}
                aria-expanded={false} onClick={() => setHelp(true)}>What does “Can call me anytime” do?</Button>
            ))}
            {snap.loaded && snap.friends.length === 0 && (
              <EmptyState>No friends yet. Add someone by their handle, or {phone ? 'tap' : 'right-click'} a name in Members.</EmptyState>
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
      <ConfirmDialog
        open={!!removing}
        title={`Remove ${removing?.username ?? 'friend'}?`}
        confirmLabel="Remove friend"
        onConfirm={() => { if (removing) void friends.removeFriend(removing); setRemoving(null); }}
        onCancel={() => setRemoving(null)}
      >
        <p>You'll stop being friends: they lose “Can call me anytime”, and you'd need to send a new request to be friends again.</p>
      </ConfirmDialog>
    </main>
  );
}

function FriendRow({ f, phone, onRemove }: { f: Friend; phone: boolean; onRemove: () => void }) {
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
            onClick={onRemove}>Remove friend</Button>
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
            onClick={onRemove}>Remove</Button>
        </>
      )}
    />
  );
}
