import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { shouldNotify, Notifier, type NotifyEvent } from './notifier';
import { DEFAULT_NOTIFICATION_SETTINGS, setNotificationSettings, __resetNotificationSettingsCache } from './notifications.store';

const ev = (over: Partial<NotifyEvent> = {}): NotifyEvent => ({
  serverId: 's1', channel: '#general', from: 'alice', text: 'hey there', kind: 'mention', ...over,
});

describe('shouldNotify', () => {
  const on = DEFAULT_NOTIFICATION_SETTINGS;

  it('never notifies while the window is focused', () => {
    expect(shouldNotify(ev(), on, true)).toBe(false);
  });
  it('notifies mentions + DMs when blurred (defaults)', () => {
    expect(shouldNotify(ev({ kind: 'mention' }), on, false)).toBe(true);
    expect(shouldNotify(ev({ kind: 'dm' }), on, false)).toBe(true);
  });
  it('does not notify plain messages unless allMessages is on', () => {
    expect(shouldNotify(ev({ kind: 'message' }), on, false)).toBe(false);
    expect(shouldNotify(ev({ kind: 'message' }), { ...on, allMessages: true }, false)).toBe(true);
  });
  it('respects per-type + master toggles', () => {
    expect(shouldNotify(ev({ kind: 'mention' }), { ...on, mentions: false }, false)).toBe(false);
    expect(shouldNotify(ev({ kind: 'dm' }), { ...on, directMessages: false }, false)).toBe(false);
    expect(shouldNotify(ev(), { ...on, enabled: false }, false)).toBe(false);
  });
});

describe('Notifier.notify', () => {
  let ctor: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    localStorage.clear();
    __resetNotificationSettingsCache();
    ctor = vi.fn();
    (ctor as unknown as { permission: string }).permission = 'granted';
    (globalThis as { Notification?: unknown }).Notification = ctor;
  });
  afterEach(() => { delete (globalThis as { Notification?: unknown }).Notification; });

  it('fires an OS Notification for a blurred mention', () => {
    const n = new Notifier();
    n.setFocusedForTest(false);
    n.notify(ev({ kind: 'mention' }));
    expect(ctor).toHaveBeenCalledOnce();
    const [title, opts] = ctor.mock.calls[0];
    expect(title).toBe('alice · #general');
    expect((opts as { tag: string }).tag).toBe('s1:#general');
  });

  it('uses the sender as the title for a DM', () => {
    const n = new Notifier();
    n.setFocusedForTest(false);
    n.notify(ev({ kind: 'dm', channel: 'bob', from: 'bob' }));
    expect(ctor.mock.calls[0][0]).toBe('bob');
  });

  it('appends the server name to the title when present', () => {
    const n = new Notifier();
    n.setFocusedForTest(false);
    n.notify(ev({ kind: 'mention', serverName: 'IRCForever' }));
    expect(ctor.mock.calls[0][0]).toBe('alice · #general · IRCForever');
  });

  it('does not fire when focused or when disabled', () => {
    const n = new Notifier();
    n.setFocusedForTest(true);
    n.notify(ev());
    expect(ctor).not.toHaveBeenCalled();

    n.setFocusedForTest(false);
    setNotificationSettings({ enabled: false });
    n.notify(ev());
    expect(ctor).not.toHaveBeenCalled();
  });

  it('does not fire without notification permission', () => {
    (ctor as unknown as { permission: string }).permission = 'denied';
    const n = new Notifier();
    n.setFocusedForTest(false);
    n.notify(ev());
    expect(ctor).not.toHaveBeenCalled();
  });
});
