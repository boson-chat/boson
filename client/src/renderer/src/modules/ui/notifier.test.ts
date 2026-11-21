import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { shouldNotify, Notifier, type NotifyEvent } from './notifier';
import { DEFAULT_NOTIFICATION_SETTINGS, setNotificationSettings, __resetNotificationSettingsCache } from './notifications.store';

const ev = (over: Partial<NotifyEvent> = {}): NotifyEvent => ({
  serverId: 's1', channel: '#general', from: 'alice', text: 'hey there', kind: 'mention', ...over,
});

describe('shouldNotify', () => {
  const on = DEFAULT_NOTIFICATION_SETTINGS;
  const focused = { focused: true, visible: true };
  const behind = { focused: false, visible: true }; // another app has focus
  const minimised = { focused: false, visible: false };

  it('never notifies while the window is focused', () => {
    expect(shouldNotify(ev(), on, focused)).toBe(false);
    expect(shouldNotify(ev({ kind: 'dm' }), on, focused)).toBe(false);
    expect(shouldNotify(ev({ open: true }), on, focused)).toBe(false);
  });
  it('notifies mentions + DMs when blurred (defaults)', () => {
    expect(shouldNotify(ev({ kind: 'mention' }), on, behind)).toBe(true);
    expect(shouldNotify(ev({ kind: 'dm' }), on, behind)).toBe(true);
  });
  it('stays quiet for the open conversation while the window is visible', () => {
    expect(shouldNotify(ev({ kind: 'mention', open: true }), on, behind)).toBe(false);
    expect(shouldNotify(ev({ kind: 'dm', open: true }), on, behind)).toBe(false);
    expect(shouldNotify(ev({ kind: 'message', open: true }), { ...on, allMessages: true }, behind)).toBe(false);
  });
  it('still notifies for other conversations while the window is visible but unfocused', () => {
    expect(shouldNotify(ev({ kind: 'mention', open: false }), on, behind)).toBe(true);
  });
  it('notifies for everything, the open conversation included, when minimised / hidden', () => {
    expect(shouldNotify(ev({ kind: 'mention', open: true }), on, minimised)).toBe(true);
    expect(shouldNotify(ev({ kind: 'dm', open: true }), on, minimised)).toBe(true);
    expect(shouldNotify(ev({ kind: 'mention' }), on, minimised)).toBe(true);
  });
  it('does not notify plain messages unless allMessages is on', () => {
    expect(shouldNotify(ev({ kind: 'message' }), on, behind)).toBe(false);
    expect(shouldNotify(ev({ kind: 'message' }), { ...on, allMessages: true }, behind)).toBe(true);
  });
  it('respects per-type + master toggles', () => {
    expect(shouldNotify(ev({ kind: 'mention' }), { ...on, mentions: false }, behind)).toBe(false);
    expect(shouldNotify(ev({ kind: 'dm' }), { ...on, directMessages: false }, behind)).toBe(false);
    expect(shouldNotify(ev(), { ...on, enabled: false }, behind)).toBe(false);
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

  it('raises one banner for the same line arriving over two connections', () => {
    const n = new Notifier();
    n.setFocusedForTest(false);
    n.notify(ev({ serverId: 's1' }));
    n.notify(ev({ serverId: 's2', from: 'Alice' }));
    expect(ctor).toHaveBeenCalledOnce();
    n.notify(ev({ serverId: 's2', text: 'something else' }));
    expect(ctor).toHaveBeenCalledTimes(2);
  });

  it('follows the native window state over DOM focus when the shell has one', () => {
    const n = new Notifier();
    n.setAttentionForTest({ focused: true, visible: true });
    n.notify(ev());
    expect(ctor).not.toHaveBeenCalled();
    n.setAttentionForTest({ focused: false, visible: true });
    n.notify(ev({ open: true }));
    expect(ctor).not.toHaveBeenCalled();
    n.setAttentionForTest({ focused: false, visible: false });
    n.notify(ev({ open: true }));
    expect(ctor).toHaveBeenCalledOnce();
  });
});

describe('Notifier window tracking', () => {
  afterEach(() => { delete (window as { bosonWindow?: unknown }).bosonWindow; vi.restoreAllMocks(); });

  it('starts from document.hasFocus() and follows window focus/blur', () => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(false);
    const n = new Notifier();
    n.start();
    expect(n.isFocused()).toBe(false);
    window.dispatchEvent(new Event('focus'));
    expect(n.isFocused()).toBe(true);
    window.dispatchEvent(new Event('blur'));
    expect(n.isFocused()).toBe(false);
  });

  it('treats a hidden page as unfocused and not visible', () => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    const vis = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    const n = new Notifier();
    n.start();
    expect(n.attention()).toEqual({ focused: true, visible: true });
    vis.mockReturnValue('hidden');
    document.dispatchEvent(new Event('visibilitychange'));
    expect(n.attention()).toEqual({ focused: false, visible: false });
  });

  it('uses the shell window events when present (WKWebView focus is unreliable)', async () => {
    // The webview claims no focus and never fires `focus`; the native window is key.
    vi.spyOn(document, 'hasFocus').mockReturnValue(false);
    let state = { focused: true, visible: true };
    let changed: (() => void) | null = null;
    (window as { bosonWindow?: unknown }).bosonWindow = {
      attention: () => Promise.resolve(state),
      onAttentionChange: (fn: () => void) => { changed = fn; return () => {}; },
    };
    const n = new Notifier();
    n.start();
    await vi.waitFor(() => expect(n.isFocused()).toBe(true));
    state = { focused: false, visible: false };
    changed!();
    await vi.waitFor(() => expect(n.attention()).toEqual({ focused: false, visible: false }));
  });

  it('falls back to DOM focus when the shell calls fail', async () => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(false);
    (window as { bosonWindow?: unknown }).bosonWindow = {
      attention: () => Promise.reject(new Error('unsupported')),
      onAttentionChange: () => () => {},
    };
    const n = new Notifier();
    n.start();
    await Promise.resolve();
    expect(n.isFocused()).toBe(false);
    window.dispatchEvent(new Event('focus'));
    await Promise.resolve();
    expect(n.isFocused()).toBe(true);
  });
});

describe('in-app toasts', () => {
  beforeEach(async () => {
    localStorage.clear();
    __resetNotificationSettingsCache();
    const { setNotificationFeed, NotificationFeed } = await import('../notifications/feed');
    setNotificationFeed(new NotificationFeed());
  });

  it('a mention or DM elsewhere toasts, focused or not; the open conversation does not', async () => {
    const { getNotificationFeed } = await import('../notifications/feed');
    const n = new Notifier();
    n.setFocusedForTest(true);
    n.notify(ev({ kind: 'mention', channel: '#ops', serverName: 'Nebula' }));
    n.notify(ev({ kind: 'dm', channel: 'mira', from: 'mira', text: 'psst' }));
    n.notify(ev({ kind: 'mention', channel: '#dev', text: 'here', open: true }));
    const t = getNotificationFeed().getSnapshot().toasts;
    expect(t.map((x) => [x.kind, x.title, x.where])).toEqual([
      ['dm', 'mira', 'direct message'],
      ['mention', 'alice', '#ops · Nebula'],
    ]);
  });

  it('the open conversation toasts while something else covers it', async () => {
    const { getNotificationFeed } = await import('../notifications/feed');
    const { setConversationShown } = await import('./notifier');
    setConversationShown(() => false);
    new Notifier().notify(ev({ kind: 'dm', channel: 'mira', from: 'mira', open: true }));
    setConversationShown(null);
    expect(getNotificationFeed().getSnapshot().toasts).toHaveLength(1);
  });

  it('follows the switches and the channel level', async () => {
    const { getNotificationFeed } = await import('../notifications/feed');
    const { setChannelLevel } = await import('./notifications.store');
    const n = new Notifier();
    setNotificationSettings({ inApp: false });
    n.notify(ev({ text: 'one' }));
    expect(getNotificationFeed().getSnapshot().toasts).toHaveLength(0);
    setNotificationSettings({ inApp: true, mentions: false });
    n.notify(ev({ text: 'two' }));
    expect(getNotificationFeed().getSnapshot().toasts).toHaveLength(0);
    setNotificationSettings({ mentions: true });
    // A plain message: only for a channel set to All.
    n.notify(ev({ kind: 'message', text: 'three' }));
    expect(getNotificationFeed().getSnapshot().toasts).toHaveLength(0);
    setChannelLevel('s1', '#general', 'all');
    n.notify(ev({ kind: 'message', text: 'four' }));
    expect(getNotificationFeed().getSnapshot().toasts).toHaveLength(1);
    setChannelLevel('s1', '#general', 'nothing');
    n.notify(ev({ kind: 'mention', text: 'five' }));
    expect(getNotificationFeed().getSnapshot().toasts).toHaveLength(1);
  });
});

describe('Notifier.clearForSignOut', () => {
  afterEach(() => { delete (globalThis as { Notification?: unknown }).Notification; localStorage.clear(); __resetNotificationSettingsCache(); });

  it("takes down the account's system notifications still showing", () => {
    const closed: string[] = [];
    class N {
      static permission = 'granted';
      onclick: (() => void) | null = null;
      onclose: ((e: Event) => void) | null = null;
      constructor(public title: string) {}
      close(): void { closed.push(this.title); this.onclose?.(new Event('close')); }
    }
    (globalThis as { Notification?: unknown }).Notification = N;
    const n = new Notifier();
    n.setFocusedForTest(false);
    n.notify(ev({ kind: 'dm', channel: 'bob', from: 'bob', text: 'private' }));
    n.notifyOther({ title: 'Missed call', body: 'from bob', tag: 'call' });
    n.clearForSignOut();
    expect(closed.sort()).toEqual(['Missed call', 'bob']);
    // The same line for the next account isn't swallowed as a duplicate.
    n.notify(ev({ kind: 'dm', channel: 'bob', from: 'bob', text: 'private' }));
    n.clearForSignOut();
    expect(closed).toHaveLength(3);
  });
});
