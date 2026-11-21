import { useState } from 'preact/hooks';
import { Phone, Video, X } from 'lucide-preact';
import { Button, Toggle } from '@boson/shared';
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
        <p class="friends-empty friends-signin">Sign in to your Boson account to add friends and call them.</p>
      </main>
    );
  }
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
    <div class="friends-tabs" role="tablist" aria-label="Friends">
      {tabs.map((t) => (
        <button key={t.id} type="button" role="tab" aria-selected={tab === t.id}
          class={`friends-tab${tab === t.id ? ' friends-tab-on' : ''}`} onClick={() => setTab(t.id)}>
          {t.label}
        </button>
      ))}
    </div>
  );
  const add = (
    <form class="friends-add" onSubmit={send}>
      <label for={`friends-add-${layout}`} class="friends-sr">Add a friend by handle</label>
      <input
        id={`friends-add-${layout}`}
        class="friends-add-input"
        placeholder="Add a friend by handle"
        autocomplete="off"
        autocapitalize="off"
        spellcheck={false}
        value={handle}
        onInput={(e) => setHandle((e.target as HTMLInputElement).value)}
      />
      <Button type="submit" variant="primary" size="sm" loading={sending}>
        {phone ? 'Add' : 'Send request'}
      </Button>
    </form>
  );
  return (
    <main class={`friends friends-${layout}`} aria-label="Friends">
      {phone ? (
        <>{add}{tabList}</>
      ) : (
        <header class="friends-head">
          <h1 class="friends-title">Friends</h1>
          {tabList}
          <div class="friends-head-fill" />
          {add}
        </header>
      )}
      <div class="friends-list" role="tabpanel">
        {tab === 'all' && (
          <>
            {snap.friends.map((f) => <FriendRow key={f.userId} f={f} phone={phone} />)}
            {snap.loaded && snap.friends.length === 0 && (
              <p class="friends-empty">No friends yet. Add someone by their handle, or {phone ? 'tap' : 'right-click'} a name in Members.</p>
            )}
            {snap.friends.length > 0 && (
              <p class="friends-note">“Can call me anytime” lets that friend through even when you're on Do not disturb or calls are set to Nobody. Off, they can call you when your settings allow it (by default, friends can). To stop someone calling, remove or block them.</p>
            )}
          </>
        )}
        {tab === 'pending' && (
          <>
            {pending.map(({ f, incoming }) => (
              <div key={f.userId} class="friends-row">
                <Avatar nick={f.username} accountUrl={f.avatarUrl} size={phone ? 40 : 36} class="friends-av" />
                <div class="friends-who">
                  <span class="friends-name">{f.username}</span>
                  <span class="friends-sub">{incoming ? 'wants to be your friend' : phone ? 'request sent' : 'request sent, waiting'}</span>
                </div>
                {incoming ? (
                  phone ? (
                    <div class="friends-actions">
                      <button type="button" class="friends-ib friends-ib-danger" aria-label={`Decline ${f.username}`} onClick={() => { void friends.deleteRequest(f); }}>
                        <X size={18} aria-hidden="true" />
                      </button>
                      <button type="button" class="friends-btn friends-btn-ok" onClick={() => { void friends.acceptRequest(f); }}>Accept</button>
                    </div>
                  ) : (
                    <div class="friends-actions">
                      <button type="button" class="friends-btn friends-btn-ok" onClick={() => { void friends.acceptRequest(f); }}>Accept</button>
                      <button type="button" class="friends-btn" onClick={() => { void friends.deleteRequest(f); }}>Decline</button>
                    </div>
                  )
                ) : (
                  <button type="button" class="friends-btn" onClick={() => { void friends.deleteRequest(f); }}>Cancel</button>
                )}
              </div>
            ))}
            {pending.length === 0 && <p class="friends-empty">No pending requests.</p>}
          </>
        )}
        {tab === 'blocked' && (
          <>
            {snap.blocked.map((f) => (
              <div key={f.userId} class="friends-row">
                <Avatar nick={f.username} accountUrl={f.avatarUrl} size={phone ? 40 : 36} class="friends-av friends-av-dim" />
                <div class="friends-who">
                  <span class="friends-name">{f.username}</span>
                  {!phone && <span class="friends-sub friends-sub-dim">Can't call you or send you friend requests. They aren't told.</span>}
                </div>
                <button type="button" class="friends-btn" onClick={() => { void friends.unblock(f); }}>Unblock</button>
              </div>
            ))}
            {snap.blocked.length === 0 && <p class="friends-empty">Nobody blocked.</p>}
          </>
        )}
      </div>
    </main>
  );
}

function FriendRow({ f, phone }: { f: Friend; phone: boolean }) {
  const { friends } = useFriends();
  if (!friends) return null;
  const sw = (
    <Toggle checked={f.canCallAnytime} onChange={(on) => { void friends.setAnytime(f, on); }}
      label={phone ? undefined : 'Can call me anytime'} ariaLabel={`${f.username} can call me anytime`} />
  );
  const calls = (
    <>
      <button type="button" class="friends-ib friends-ib-ok" aria-label={`Call ${f.username}`} onClick={() => { void friends.call(f.username, false); }}>
        <Phone size={phone ? 18 : 16} aria-hidden="true" />
      </button>
      <button type="button" class="friends-ib friends-ib-ok" aria-label={`Video call ${f.username}`} onClick={() => { void friends.call(f.username, true); }}>
        <Video size={phone ? 18 : 16} aria-hidden="true" />
      </button>
    </>
  );
  const sub = f.displayName && f.displayName !== f.username ? f.displayName : 'Friend';
  if (phone) {
    return (
      <div class="friends-row friends-row-phone">
        <div class="friends-row-top">
          <Avatar nick={f.username} accountUrl={f.avatarUrl} size={40} class="friends-av" />
          <div class="friends-who">
            <span class="friends-name">{f.username}</span>
            <span class="friends-sub">{sub}</span>
          </div>
          {calls}
        </div>
        <div class="friends-row-anytime">
          <span class="friends-anytime-label" aria-hidden="true">Can call me anytime</span>
          {sw}
        </div>
        <div class="friends-row-remove">
          <button type="button" class="friends-btn friends-btn-ghost friends-remove" aria-label={`Remove ${f.username} from friends`}
            onClick={() => { void friends.removeFriend(f); }}>Remove friend</button>
        </div>
      </div>
    );
  }
  return (
    <div class="friends-row">
      <Avatar nick={f.username} accountUrl={f.avatarUrl} size={36} class="friends-av" />
      <div class="friends-who">
        <span class="friends-name">{f.username}</span>
        <span class="friends-sub">{sub}</span>
      </div>
      <span class="friends-anytime">{sw}</span>
      {calls}
      <button type="button" class="friends-btn friends-btn-ghost" aria-label={`Remove ${f.username} from friends`}
        onClick={() => { void friends.removeFriend(f); }}>Remove</button>
    </div>
  );
}
