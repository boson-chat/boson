import type { ComponentChildren } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { createPortal } from 'preact/compat';
import { ArrowLeft, CheckCheck, Phone, Settings, X } from 'lucide-preact';
import { AtomLoader, Button, EmptyState, ListRow, PageHeader, Segmented, StatusDot } from '@boson/shared';
import { Avatar } from '../../shared/Avatar/Avatar';
import { getAvatar, subscribeAvatars } from '../../modules/chat/avatar-cache';
import { getMemoStore, type Memo } from '../../modules/memos';
import { publishReadMemo } from '../../modules/inbox-nav/inbox-nav';
import { getNotificationFeed, type FeedItem } from '../../modules/notifications/feed';
import { useFeed } from '../../modules/notifications/use-feed';
import { useFriends } from '../../modules/friends';
import { joinVoice, openCalls, openConversation, openFriends } from './navigate';
import './NotificationsPanel.css';

export type NoteFilter = 'all' | 'mention' | 'message' | 'friend' | 'call';

const FILTERS: Array<[NoteFilter, string]> = [
  ['all', 'All'], ['mention', 'Mentions'], ['message', 'Messages'], ['friend', 'Friends'], ['call', 'Calls'],
];

// One row of the list: an inbox entry (mention, DM, memo, service notice)
// or a friend / call event.
export interface Note {
  id: string;
  group: Exclude<NoteFilter, 'all'>;
  title: string;
  where: string;
  body: string;
  at: number;
  // Shown instead of "5m" (a memo's own date).
  time?: string;
  unread: boolean;
  nick: string;
  serverId?: string;
  memo?: Memo;
  feed?: FeedItem;
}

// A LIST-sourced memo whose body we haven't fetched yet (fetched when
// opened, so it stays unread on the server until then).
function unfetched(m: Memo): boolean {
  return m.kind === 'memo' && m.memoIndex != null && !m.bodyFetched;
}

export function memoNote(m: Memo): Note {
  const server = m.serverName || m.serverId || '';
  const base = { id: `memo:${m.id}`, at: m.timestamp, unread: !m.read, nick: m.sender || '?', serverId: m.serverId, memo: m };
  switch (m.kind) {
    case 'mention': return { ...base, group: 'mention', title: m.sender, where: [m.channel, server].filter(Boolean).join(' · '), body: m.text };
    case 'dm': return { ...base, group: 'message', title: m.sender, where: `direct message${server ? ` · ${server}` : ''}`, body: m.text };
    case 'memo': return { ...base, group: 'message', title: `Memo from ${m.sender}`, where: server, body: unfetched(m) ? '' : m.text, ...(m.memoDate ? { time: m.memoDate } : {}) };
    default: return { ...base, group: 'message', title: m.sender || 'unknown', where: server, body: m.text };
  }
}

export function feedNote(i: FeedItem): Note {
  return { id: `feed:${i.id}`, group: i.kind, title: i.title, where: i.where, body: i.body, at: i.at, unread: !i.read, nick: i.nick, feed: i };
}

/** Unread first, then newest. */
export function sortNotes(notes: Note[]): Note[] {
  return notes.sort((a, b) => Number(b.unread) - Number(a.unread) || b.at - a.at);
}

/** How many entries are unread (the bell's badge). */
export function useUnreadNotes(): number {
  const [memos, setMemos] = useState<ReadonlyArray<Memo>>(() => getMemoStore().list());
  useEffect(() => getMemoStore().subscribe(setMemos), []);
  const { items } = useFeed();
  return memos.reduce((n, m) => n + (m.read ? 0 : 1), 0) + items.reduce((n, i) => n + (i.read ? 0 : 1), 0);
}

interface Props {
  layout: 'desktop' | 'phone';
  onClose: () => void;
  onOpenSettings?: () => void;
}

// The bell: one list of everything (the Inbox's mentions, DMs and memos,
// with friend requests and calls), unread first with a dot, filters, Mark
// all read. Desktop: a panel under the bell; phones: full screen.
export function NotificationsPanel({ layout, onClose, onOpenSettings }: Props) {
  const phone = layout === 'phone';
  const [memos, setMemos] = useState<ReadonlyArray<Memo>>(() => getMemoStore().list());
  useEffect(() => getMemoStore().subscribe(setMemos), []);
  const { items } = useFeed();
  const [filter, setFilter] = useState<NoteFilter>('all');
  const [loading, setLoading] = useState<ReadonlySet<string>>(new Set());
  const [, bumpAvatars] = useState(0);
  useEffect(() => subscribeAvatars(() => bumpAvatars((n) => n + 1)), []);
  const ref = useRef<HTMLDivElement>(null);
  // Esc closes; desktop: so does a click outside.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') onClose(); };
    const onDown = (e: MouseEvent): void => {
      const t = e.target as HTMLElement;
      if (!ref.current?.contains(t) && !t.closest?.('.title-bar-bell')) onClose();
    };
    document.addEventListener('keydown', onKey);
    if (!phone) document.addEventListener('mousedown', onDown);
    ref.current?.focus();
    // The list has everything: no toasts over it meanwhile.
    document.body.classList.add('bell-open');
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onDown);
      document.body.classList.remove('bell-open');
    };
  }, [onClose, phone]);

  // Clear waits a few seconds (with Undo) before it removes anything; the
  // panel closing makes it final.
  const [cleared, setCleared] = useState<ReadonlySet<string> | null>(null);
  const commitRef = useRef<() => void>(() => {});
  useEffect(() => {
    if (!cleared) return;
    const t = setTimeout(() => commitRef.current(), CLEAR_UNDO_MS);
    return () => clearTimeout(t);
  }, [cleared]);
  useEffect(() => () => commitRef.current(), []);
  const { friends, snap: fsnap } = useFriends();

  const all = sortNotes([...memos.map(memoNote), ...items.map(feedNote)]).filter((n) => !cleared?.has(n.id));
  const shown = filter === 'all' ? all : all.filter((n) => n.group === filter);
  const unread = all.filter((n) => n.unread).length;
  const feed = getNotificationFeed();
  const memoStore = getMemoStore();

  const beginRead = (m: Memo): void => {
    const id = m.id;
    setLoading((s) => new Set(s).add(id));
    setTimeout(() => setLoading((s) => { if (!s.has(id)) return s; const n = new Set(s); n.delete(id); return n; }), 8000);
    if (m.memoIndex != null) publishReadMemo({ serverId: m.serverId, memoIndex: m.memoIndex });
  };
  const open = (n: Note): void => {
    if (n.memo && unfetched(n.memo)) { beginRead(n.memo); return; }
    if (n.memo) {
      memoStore.markRead(n.memo.id);
      const m = n.memo;
      openConversation(m.serverId, m.kind === 'dm' ? m.sender : m.kind === 'mention' ? (m.channel ?? null) : null);
    } else if (n.feed) {
      feed.markRead(n.feed.id);
      if (n.feed.kind === 'friend') openFriends();
      else if (n.feed.sub === 'started' && n.feed.room) joinVoice(n.feed.room);
      else openCalls();
    }
    onClose();
  };
  const dismiss = (n: Note): void => {
    if (n.memo) memoStore.remove(n.memo.id);
    else if (n.feed) feed.remove(n.feed.id);
  };
  // Removes exactly what was cleared (not what arrived since).
  commitRef.current = (): void => {
    if (!cleared) return;
    for (const n of [...memos.map(memoNote), ...items.map(feedNote)]) {
      if (!cleared.has(n.id)) continue;
      if (n.memo) memoStore.remove(n.memo.id);
      else if (n.feed) feed.remove(n.feed.id);
    }
    setCleared(null);
  };
  const clear = (): void => {
    commitRef.current();
    if (shown.length === 0) return;
    // Missed calls cleared from the bell are seen on the Calls page too.
    if (shown.some((n) => n.feed?.sub === 'missed') && fsnap.missed > 0) void friends?.seeMissed();
    setCleared(new Set(shown.map((n) => n.id)));
  };
  const undoClear = (): void => setCleared(null);

  // One read state: Mark all read also sees the missed calls (MY's badge).
  const markAll = (): void => {
    memoStore.markAllRead();
    feed.markAllRead();
    if (fsnap.missed > 0) void friends?.seeMissed();
  };
  // A row's own buttons, the same as its toast's: Accept / Ignore a friend
  // request, Call back a missed call, Join a call that started.
  const rowActions = (n: Note): ComponentChildren => {
    const f = n.feed;
    if (!f || !friends) return null;
    const size = phone ? 'lg' : 'sm';
    const read = (): void => feed.markRead(f.id);
    if (f.sub === 'request') {
      const who = fsnap.incoming.find((x) => x.username === f.nick);
      if (!who) return null;
      return (
        <>
          <Button variant="success" size={size} aria-label={`Accept ${who.username}'s friend request`}
            onClick={() => { read(); void friends.acceptRequest(who); }}>Accept</Button>
          <Button variant="secondary" size={size} aria-label={`Ignore ${who.username}'s friend request`}
            onClick={() => { read(); void friends.deleteRequest(who); }}>Ignore</Button>
        </>
      );
    }
    if (f.sub === 'missed' && f.call) {
      const call = f.call;
      return (
        <Button variant="secondary" tone="success" size={size} icon={<Phone aria-hidden="true" />} aria-label={`Call ${call.peer} back`}
          onClick={() => { read(); onClose(); void friends.call(call.peer, call.video); }}>Call back</Button>
      );
    }
    if (f.sub === 'started' && f.room) {
      const room = f.room;
      return (
        <Button variant="secondary" tone="success" size={size} aria-label={`Join ${room.name}`}
          onClick={() => { read(); onClose(); joinVoice(room); }}>Join</Button>
      );
    }
    return null;
  };
  const settingsBtn = onOpenSettings && (
    <Button variant="ghost" size={phone ? 'lg' : 'sm'} icon={<Settings aria-hidden="true" />} aria-label="Notification settings" title="Notification settings" onClick={onOpenSettings} />
  );
  const head = phone ? (
    <PageHeader layout="phone" title={<span id="notes-title">Notifications</span>} sub={`${unread} unread`} onBack={onClose} backLabel="Back"
      backIcon={<ArrowLeft aria-hidden="true" />}
      actions={<>
        {/* An icon on phones: the words would squeeze the title. */}
        <Button variant="ghost" size="lg" onClick={markAll} disabled={unread === 0} icon={<CheckCheck aria-hidden="true" />}
          aria-label="Mark all read" title="Mark all read" />
        {settingsBtn}
      </>} />
  ) : (
    <div class="notes-head">
      <h2 class="notes-title" id="notes-title">Notifications</h2>
      <Button variant="ghost" size="sm" onClick={markAll} disabled={unread === 0}>Mark all read</Button>
      {shown.length > 0 && <Button variant="ghost" size="sm" onClick={clear}>{filter === 'all' ? 'Clear' : 'Clear these'}</Button>}
      {settingsBtn}
    </div>
  );
  const body = (
    <>
      {head}
      <div class="notes-filters">
        <Segmented semantics="tabs" label="Show" value={filter} size={phone ? 'lg' : 'md'} onChange={setFilter}
          options={FILTERS.map(([k, label]) => {
            const n = k === 'all' ? unread : all.filter((x) => x.group === k && x.unread).length;
            return { id: k, label, ariaLabel: n > 0 ? `${label}, ${n} unread` : label };
          })} />
      </div>
      {cleared && (
        <div class="notes-undo" role="status">
          <span>Cleared {cleared.size} notification{cleared.size === 1 ? '' : 's'}</span>
          <Button variant="secondary" size={phone ? 'lg' : 'sm'} onClick={undoClear}>Undo</Button>
        </div>
      )}
      <ul class="notes-list" role="tabpanel" aria-label={FILTERS.find(([k]) => k === filter)![1]}>
        {shown.length === 0 && <li class="notes-empty"><EmptyState>{EMPTY[filter]}</EmptyState></li>}
        {shown.map((n) => {
          const pending = !!n.memo && unfetched(n.memo);
          const url = n.serverId ? getAvatar(n.serverId, n.nick) : undefined;
          return (
            <ListRow key={n.id} as="li" class="notes-item" size={phone ? 'lg' : 'md'} unread={n.unread}
              onClick={() => open(n)}
              ariaLabel={`${n.unread ? 'Unread: ' : ''}${n.title}${n.where ? `, ${n.where}` : ''}${n.body ? `: ${n.body}` : ''}${pending ? '. Read memo' : ''}`}
              leading={<Avatar nick={n.nick} url={url} size={phone ? 38 : 32} />}
              title={n.title}
              meta={n.where || undefined}
              aside={<><span class="notes-time">{n.time ?? ago(n.at)}</span>{n.unread && <StatusDot status="accent" size={8} class="notes-dot" />}</>}
              subtitleLines={2}
              subtitle={pending
                ? (loading.has(n.memo!.id)
                  ? <span class="notes-loading"><AtomLoader size={14} label="Fetching memo" /> Fetching…</span>
                  : <span class="notes-placeholder">{phone ? 'Tap' : 'Click'} to read →</span>)
                : n.body}
              trailing={<Button variant="ghost" size={phone ? 'lg' : 'sm'} class="notes-x" icon={<X aria-hidden="true" />} aria-label={`Remove ${n.title}`} onClick={() => dismiss(n)} />}
            >
              {(() => { const a = rowActions(n); return a ? <div class="notes-actions">{a}</div> : null; })()}
            </ListRow>
          );
        })}
        {phone && shown.length > 0 && (
          <li class="notes-foot"><Button variant="ghost" size="lg" onClick={clear}>Clear {filter === 'all' ? 'all' : 'these'}</Button></li>
        )}
      </ul>
    </>
  );
  return createPortal(
    <div ref={ref} tabIndex={-1} role="dialog" aria-labelledby="notes-title" class={`notes notes-${layout}`}>{body}</div>,
    document.body,
  );
}

/** How long Clear can be undone. */
export const CLEAR_UNDO_MS = 6_000;

const EMPTY: Record<NoteFilter, string> = {
  all: 'Nothing yet. Mentions, direct messages, memos, friend requests and calls collect here.',
  mention: 'No mentions. When someone says your nick in a channel, it shows up here.',
  message: 'No messages. Direct messages and MemoServ memos from every network land here.',
  friend: 'No friend requests.',
  call: 'No calls. Missed calls and calls starting in your voice channels show up here.',
};

// "now", "5m", "2h", "yesterday", "3d", else the date.
export function ago(at: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 60) return 'now';
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  const d = Math.floor(s / 86400);
  if (d === 1) return 'yesterday';
  if (d < 7) return `${d}d`;
  return new Date(at).toLocaleDateString([], { month: 'short', day: 'numeric' });
}
