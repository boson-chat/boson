import { describe, expect, it } from 'vitest';
import { handleClick, handlePush, OPEN_MESSAGE, type SWDeps, type SWNotification } from './push-sw-core';
import { liveKey, PREFS_KEY, pushKV } from './push-idb';
import { DEFAULT_PUSH_PREFS } from '../../modules/push/filter';

function deps(over: Partial<SWDeps> = {}) {
  const shown: Array<{ title: string; opts: NotificationOptions & { data: unknown } }> = [];
  const closed: string[] = [];
  const opened: string[] = [];
  const posted: unknown[] = [];
  const existing: SWNotification[] = [];
  const d: SWDeps = {
    serverId: 's1', serverName: 'Boson', appUrl: 'https://chat.example/', kv: pushKV(undefined), now: () => 1_000_000,
    showNotification: async (title, opts) => { shown.push({ title, opts }); },
    getNotifications: async (tag) => existing.filter((n) => !tag || n.tag === tag),
    windows: async () => [],
    openWindow: async (url) => { opened.push(url); },
    ...over,
  };
  const note = (tag: string, time?: string): SWNotification => {
    const n: SWNotification = { tag, data: { time }, close: () => { closed.push(`${tag}@${time}`); } };
    existing.push(n);
    return n;
  };
  return { d, shown, closed, opened, posted, note };
}

describe('handlePush', () => {
  it('shows a mention as "<nick> in #channel · server", tagged per conversation', async () => {
    const { d, shown } = deps();
    expect(await handlePush('@time=2026-11-27T10:00:00.000Z :thelion!u@h PRIVMSG #Team :bob: ship it', d)).toBe('shown');
    expect(shown).toEqual([{
      title: 'thelion in #Team · Boson',
      opts: { body: 'bob: ship it', tag: 's1:#team', renotify: true, data: { serverId: 's1', conversation: '#Team', time: '2026-11-27T10:00:00.000Z' } },
    }]);
  });

  it('shows a DM under the sender', async () => {
    const { d, shown } = deps();
    await handlePush(':alice!u@h PRIVMSG bob :hi', d);
    expect(shown[0]!.title).toBe('alice · Boson');
    expect(shown[0]!.opts.data).toEqual({ serverId: 's1', conversation: 'alice' });
  });

  it('the subscription test push shows nothing', async () => {
    const { d, shown } = deps();
    expect(await handlePush('PING webpush', d)).toBe('skipped');
    expect(shown).toEqual([]);
  });

  it('applies the settings the page mirrored', async () => {
    const { d, shown } = deps();
    await d.kv.set(PREFS_KEY, { ...DEFAULT_PUSH_PREFS, levels: { 's1\0#team': 'nothing' } });
    expect(await handlePush(':x!u@h PRIVMSG #team :bob', d)).toBe('skipped');
    expect(await handlePush(':x!u@h PRIVMSG #other :bob', d)).toBe('shown');
    expect(shown).toHaveLength(1);
  });

  it('leaves it to an open tab that has the server connected', async () => {
    const { d, shown } = deps({ windows: async () => [{ url: 'https://chat.example/?x', postMessage: () => {} }] });
    await d.kv.set(liveKey('s1'), 1_000_000 - 10_000);
    expect(await handlePush(':alice!u@h PRIVMSG bob :hi', d)).toBe('skipped');
    // A stale heartbeat (the tab is frozen): shown.
    await d.kv.set(liveKey('s1'), 1_000_000 - 500_000);
    expect(await handlePush(':alice!u@h PRIVMSG bob :hi', d)).toBe('shown');
    expect(shown).toHaveLength(1);
  });

  it('a read marker takes that conversation’s notifications down, up to its time', async () => {
    const { d, closed, note } = deps();
    note('s1:#team', '2026-11-27T10:00:00.000Z');
    note('s1:#team', '2026-11-27T12:00:00.000Z');
    note('s1:alice', '2026-11-27T09:00:00.000Z');
    expect(await handlePush(':irc MARKREAD #team timestamp=2026-11-27T11:00:00.000Z', d)).toBe('read');
    expect(closed).toEqual(['s1:#team@2026-11-27T10:00:00.000Z']);
  });
});

describe('handleClick', () => {
  it('focuses an open tab and asks it to open the conversation', async () => {
    const posted: unknown[] = [];
    let focused = false;
    const opened: string[] = [];
    await handleClick({ serverId: 's1', conversation: '#team' }, {
      appUrl: 'https://chat.example/',
      windows: async () => [{ url: 'https://other.example/', postMessage: () => {} }, { url: 'https://chat.example/', focus: async () => { focused = true; }, postMessage: (m) => posted.push(m) }],
      openWindow: async (u) => { opened.push(u); },
    });
    expect(focused).toBe(true);
    expect(posted).toEqual([{ type: OPEN_MESSAGE, serverId: 's1', conversation: '#team' }]);
    expect(opened).toEqual([]);
  });

  it('opens the app at the conversation when no tab is open', async () => {
    const opened: string[] = [];
    await handleClick({ serverId: 's 1', conversation: '#team' }, { appUrl: 'https://chat.example/', windows: async () => [], openWindow: async (u) => { opened.push(u); } });
    expect(opened).toEqual(['https://chat.example/?push-server=s+1&push-target=%23team']);
  });
});
