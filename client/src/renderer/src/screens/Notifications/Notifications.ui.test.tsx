import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { NotificationFeed, getNotificationFeed, setNotificationFeed } from '../../modules/notifications/feed';
import { FriendsController, setFriendsController } from '../../modules/friends';
import { FakeFriendsApi } from '../../modules/friends/friends.fake';
import { getMemoStore } from '../../modules/memos';
import { subscribeOpenConversation, subscribeReadMemo } from '../../modules/inbox-nav/inbox-nav';
import { __resetNotificationSettingsCache, setNotificationSettings } from '../../modules/ui/notifications.store';
import { getFriendsUi, setFriendsUi } from '../Friends/friends-ui';
import { TOAST_MS, Toasts } from './Toasts';
import { CLEAR_UNDO_MS, NotificationsPanel } from './NotificationsPanel';
import { IncomingCallsSetting } from './IncomingCalls';
import { setVoiceJoiner } from './navigate';

let api: FakeFriendsApi;
let ctl: FriendsController;

beforeEach(async () => {
  localStorage.clear();
  __resetNotificationSettingsCache();
  setNotificationFeed(new NotificationFeed());
  getMemoStore().clear();
  api = new FakeFriendsApi({ people: [{ username: 'kestrel', rel: 'friend' }, { username: 'juno', rel: 'incoming' }], pollWaitMs: 5 });
  ctl = new FriendsController({
    api, authUrl: 'https://auth.boson.chat', signedIn: () => true, me: () => 'ada', onAccessChange: () => () => {},
    voice: () => null, video: () => null, openCall: () => {}, toastMs: 1_000,
  });
  setFriendsController(ctl);
  ctl.start();
  await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
  setFriendsUi({ my: false, myView: 'friends', phone: null });
});

afterEach(() => {
  vi.useRealTimers();
  setFriendsController(null);
  setNotificationFeed(null);
  setVoiceJoiner(null);
});

describe('toasts', () => {
  it('a DM toast opens its conversation; a friend request has Accept / Ignore; no coloured edge', async () => {
    const opened: unknown[] = [];
    const unsub = subscribeOpenConversation((i) => opened.push(i));
    render(<Toasts />);
    act(() => {
      getNotificationFeed().toast({ kind: 'dm', title: 'mira', where: 'direct message', body: 'psst', nick: 'mira', serverId: 's1', channel: 'mira' });
      getNotificationFeed().toast({ kind: 'friend', title: 'juno', where: 'friend request', body: 'wants to be your friend', nick: 'juno', friend: ctl.getSnapshot().incoming[0]! });
    });
    const cards = screen.getAllByRole('group');
    expect(cards.map((c) => c.getAttribute('aria-label'))).toEqual(['juno · friend request', 'mira · direct message']);
    expect(getComputedStyle(cards[0]!).borderLeftWidth).not.toBe('3px');
    fireEvent.click(screen.getByRole('button', { name: "Accept juno's friend request" }));
    await waitFor(() => expect(ctl.getSnapshot().friends.map((f) => f.username)).toContain('juno'));
    fireEvent.click(screen.getByRole('button', { name: /^mira · direct message: psst\. Open$/ }));
    expect(opened).toEqual([{ serverId: 's1', target: 'mira' }]);
    expect(getFriendsUi()).toMatchObject({ my: true, myView: 'chat', phone: 'chat' });
    expect(screen.queryAllByRole('group')).toHaveLength(0);
    unsub();
  });

  it('goes after 6 s, but not while hovered; ✕ dismisses', () => {
    vi.useFakeTimers();
    render(<Toasts />);
    act(() => { getNotificationFeed().toast({ kind: 'mention', title: 'kestrel', where: '#ops', body: 'hey', nick: 'kestrel', serverId: 's1', channel: '#ops' }); });
    const card = screen.getByRole('group');
    act(() => { vi.advanceTimersByTime(TOAST_MS - 1000); });
    fireEvent.mouseEnter(card);
    act(() => { vi.advanceTimersByTime(TOAST_MS * 2); });
    expect(screen.queryByRole('group')).toBeTruthy();
    fireEvent.mouseLeave(card);
    act(() => { vi.advanceTimersByTime(1100); });
    expect(screen.queryByRole('group')).toBeNull();
    act(() => { getNotificationFeed().toast({ kind: 'dm', title: 'mira', where: '', body: 'x', nick: 'mira' }); });
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByRole('group')).toBeNull();
  });

  it('missed call: Call back and Dismiss; call started: Join and Dismiss', async () => {
    const joined: string[] = [];
    setVoiceJoiner((r) => joined.push(r.roomId));
    render(<Toasts />);
    act(() => {
      getNotificationFeed().toast({ kind: 'missed', title: 'Missed call', where: 'kestrel', body: 'Video call', nick: 'kestrel', call: { peer: 'kestrel', video: true } });
      getNotificationFeed().toast({ kind: 'started', title: 'Call started', where: 'General · Nebula', body: 'nova is in General', nick: 'nova', room: { host: 'h', roomId: 'general', name: 'General', serverName: 'Nebula' } });
    });
    expect(screen.getAllByRole('button', { name: 'Dismiss' })).toHaveLength(4); // two ✕, two Dismiss
    fireEvent.click(screen.getByRole('button', { name: 'Join General' }));
    expect(joined).toEqual(['general']);
    const call = vi.spyOn(ctl, 'call').mockResolvedValue(undefined as never);
    fireEvent.click(screen.getByRole('button', { name: 'Call kestrel back' }));
    expect(call).toHaveBeenCalledWith('kestrel', true);
  });

  it('an incoming call as a banner: Decline / Voice only / Accept, and it stays while it rings', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(<Toasts />);
    act(() => { api.ring('kestrel', true); });
    const ring = await screen.findByRole('alertdialog', { name: 'kestrel is calling' });
    expect(ring.querySelector('.call-answer')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Accept with voice only' })).toBeTruthy();
    act(() => { vi.advanceTimersByTime(TOAST_MS * 3); });
    expect(screen.getByRole('alertdialog', { name: 'kestrel is calling' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Decline call' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
  });

  it('with Incoming calls: Full screen, the banner is not shown (the full-screen call is)', async () => {
    setNotificationSettings({ incomingCalls: 'full' });
    render(<Toasts />);
    act(() => { api.ring('kestrel', false); });
    await act(async () => { await new Promise((r) => setTimeout(r, 30)); });
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });
});

describe('the bell', () => {
  it('lists everything unread first with a dot; filters; Mark all read; remove; memos fetch on open', async () => {
    const reads: unknown[] = [];
    const unsub = subscribeReadMemo((i) => reads.push(i));
    const memos = getMemoStore();
    memos.append({ serverId: 's1', serverName: 'Nebula', sender: 'nova', kind: 'mention', channel: '#ops', text: 'ada: look', timestamp: Date.now() - 60_000 });
    memos.append({ serverId: 's1', serverName: 'Nebula', sender: 'mira', kind: 'dm', text: 'psst', timestamp: Date.now() - 120_000 });
    memos.upsertMemo({ serverId: 's1', serverName: 'Nebula', sender: 'MemoServ', kind: 'memo', text: '', timestamp: Date.now() - 3_600_000, memoIndex: 2, read: false });
    getNotificationFeed().add({ id: 'c1', kind: 'call', sub: 'missed', title: 'Missed call', where: 'kestrel', body: 'Voice call', nick: 'kestrel', read: true });
    let closed = 0;
    render(<NotificationsPanel layout="desktop" onClose={() => { closed++; }} />);
    const rows = () => screen.getAllByRole('listitem');
    expect(rows().map((r) => r.querySelector('.bds-row-title')?.textContent)).toEqual(['nova', 'mira', 'Memo from MemoServ', 'Missed call']);
    expect(rows()[3]!.querySelector('.notes-dot')).toBeNull();
    fireEvent.click(screen.getByRole('tab', { name: /^Calls/ }));
    expect(rows()).toHaveLength(1);
    fireEvent.click(screen.getByRole('tab', { name: /^Messages/ }));
    expect(rows()).toHaveLength(2);
    // An unfetched memo: opening fetches it, the list stays.
    fireEvent.click(screen.getByRole('button', { name: /Memo from MemoServ.*Read memo$/ }));
    expect(reads).toEqual([{ serverId: 's1', memoIndex: 2 }]);
    expect(closed).toBe(0);
    fireEvent.click(screen.getByRole('button', { name: 'Remove mira' }));
    expect(rows()).toHaveLength(1);
    fireEvent.click(screen.getByRole('tab', { name: /^All/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Mark all read' }));
    expect(document.querySelectorAll('.notes-dot')).toHaveLength(0);
    unsub();
  });

  it('opening a mention goes to its channel; a missed call to Calls', () => {
    const opened: unknown[] = [];
    const unsub = subscribeOpenConversation((i) => opened.push(i));
    getMemoStore().append({ serverId: 's1', serverName: 'Nebula', sender: 'nova', kind: 'mention', channel: '#ops', text: 'ada: look', timestamp: Date.now() });
    getNotificationFeed().add({ id: 'c1', kind: 'call', sub: 'missed', title: 'Missed call', where: 'kestrel', body: 'Voice call', nick: 'kestrel' });
    let closed = 0;
    render(<NotificationsPanel layout="phone" onClose={() => { closed++; }} />);
    fireEvent.click(screen.getByRole('button', { name: /^Unread: nova/ }));
    expect(opened).toEqual([{ serverId: 's1', target: '#ops' }]);
    expect(getFriendsUi()).toMatchObject({ my: false, phone: 'chat' });
    fireEvent.click(screen.getByRole('button', { name: /^Unread: Missed call/ }));
    expect(getFriendsUi()).toMatchObject({ my: true, myView: 'calls', phone: 'calls' });
    expect(closed).toBe(2);
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(closed).toBe(3);
    unsub();
  });
});

describe('the bell: actions and Clear', () => {
  it("a friend request has Accept / Ignore, as its toast does; a missed call has Call back", async () => {
    getNotificationFeed().add({ id: 'friend:req:u_juno:1', kind: 'friend', sub: 'request', title: 'juno', where: 'friend request', body: 'wants to be your friend', nick: 'juno' });
    getNotificationFeed().add({ id: 'c1', kind: 'call', sub: 'missed', title: 'Missed call', where: 'kestrel', body: 'Voice call', nick: 'kestrel', call: { peer: 'kestrel', video: false } });
    render(<NotificationsPanel layout="desktop" onClose={() => {}} />);
    expect(screen.getByRole('button', { name: 'Call kestrel back' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: "Accept juno's friend request" }));
    await waitFor(() => expect(ctl.getSnapshot().friends.map((f) => f.username)).toContain('juno'));
    expect(getNotificationFeed().getSnapshot().items.find((i) => i.id === 'friend:req:u_juno:1')?.read).toBe(true);
  });

  it('Clear hides everything with Undo; Undo brings it back', () => {
    getMemoStore().append({ serverId: 's1', serverName: 'Nebula', sender: 'nova', kind: 'mention', channel: '#ops', text: 'ada: look', timestamp: Date.now() });
    getNotificationFeed().add({ id: 'c1', kind: 'call', sub: 'missed', title: 'Missed call', where: 'kestrel', body: 'Voice call', nick: 'kestrel' });
    render(<NotificationsPanel layout="desktop" onClose={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    expect(screen.queryAllByRole('listitem').filter((r) => r.querySelector('.bds-row-title'))).toHaveLength(0);
    expect(screen.getByRole('status').textContent).toContain('Cleared 2 notifications');
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    expect(screen.getAllByRole('listitem').filter((r) => r.querySelector('.bds-row-title'))).toHaveLength(2);
    expect(getMemoStore().list()).toHaveLength(1);
  });

  it('Clear is final after a few seconds, or when the list closes', () => {
    vi.useFakeTimers();
    getMemoStore().append({ serverId: 's1', serverName: 'Nebula', sender: 'nova', kind: 'mention', channel: '#ops', text: 'ada: look', timestamp: Date.now() });
    const { unmount } = render(<NotificationsPanel layout="desktop" onClose={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    expect(getMemoStore().list()).toHaveLength(1);
    act(() => { vi.advanceTimersByTime(CLEAR_UNDO_MS + 10); });
    expect(getMemoStore().list()).toHaveLength(0);
    act(() => { getNotificationFeed().add({ id: 'c2', kind: 'call', sub: 'missed', title: 'Missed call', where: 'kestrel', body: 'Voice call', nick: 'kestrel' }); });
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    unmount();
    expect(getNotificationFeed().getSnapshot().items).toHaveLength(0);
  });
});

describe('Incoming calls setting', () => {
  it('Full screen | Banner, stored on this device', () => {
    render(<IncomingCallsSetting />);
    expect(screen.getByRole('radio', { name: 'Banner' }).getAttribute('aria-checked')).toBe('true');
    fireEvent.click(screen.getByRole('radio', { name: 'Full screen' }));
    expect(screen.getByRole('radio', { name: 'Full screen' }).getAttribute('aria-checked')).toBe('true');
    expect(JSON.parse(localStorage.getItem('boson:notifications:v1')!).incomingCalls).toBe('full');
  });
});
