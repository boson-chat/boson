import { beforeEach, describe, expect, it } from 'vitest';
import { MAX_TOASTS, NotificationFeed } from './feed';

const toast = (n: number) => ({ kind: 'dm' as const, title: `p${n}`, where: 'direct message', body: 'hi', nick: `p${n}` });

describe('NotificationFeed', () => {
  beforeEach(() => localStorage.clear());

  it('keeps at most three toasts, newest first; dismiss removes one', () => {
    const f = new NotificationFeed();
    const ids = [1, 2, 3, 4].map((n) => f.toast(toast(n)));
    expect(f.getSnapshot().toasts.map((t) => t.title)).toEqual(['p4', 'p3', 'p2']);
    expect(f.getSnapshot().toasts).toHaveLength(MAX_TOASTS);
    f.dismiss(ids[2]!);
    expect(f.getSnapshot().toasts.map((t) => t.title)).toEqual(['p4', 'p2']);
  });

  it('lists friend and call events, unread until read; persists per account', () => {
    const f = new NotificationFeed();
    f.setUserId('u1');
    f.add({ id: 'a', kind: 'friend', sub: 'request', title: 'nova', where: 'friend request', body: 'wants to be your friend', nick: 'nova' });
    f.add({ id: 'b', kind: 'call', sub: 'missed', title: 'Missed call', where: 'kestrel', body: 'Video call', nick: 'kestrel' });
    expect(f.unread()).toBe(2);
    f.markRead('a');
    expect(f.unread()).toBe(1);
    const again = new NotificationFeed();
    again.setUserId('u1');
    expect(again.getSnapshot().items.map((i) => i.id)).toEqual(['b', 'a']);
    const other = new NotificationFeed();
    other.setUserId('u2');
    expect(other.getSnapshot().items).toEqual([]);
    again.clear(['call']);
    expect(again.getSnapshot().items.map((i) => i.id)).toEqual(['a']);
    again.markAllRead();
    expect(again.unread()).toBe(0);
    again.remove('a');
    expect(again.getSnapshot().items).toEqual([]);
  });
});

describe('NotificationFeed.clearForSignOut', () => {
  beforeEach(() => localStorage.clear());
  it("drops the account's toasts and list from memory, and the next account starts empty", () => {
    const f = new NotificationFeed();
    f.setUserId('u1');
    f.toast(toast(1));
    f.add({ id: 'c1', kind: 'call', sub: 'missed', title: 'bob', where: '', body: 'missed call', nick: 'bob' });
    f.clearForSignOut();
    expect(f.getSnapshot()).toEqual({ toasts: [], items: [] });
    f.setUserId('u2');
    expect(f.getSnapshot().items).toEqual([]);
  });
});
