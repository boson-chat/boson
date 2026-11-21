import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, fireEvent } from '@testing-library/preact';
import { signal } from '@preact/signals';
import { MessageRow, MessageList } from './message-render';
import type { NickProfiles } from './nick-actions';
import type { ChatMember, ChatMessage, WhoisInfo } from '../../modules/chat';
import { SeenStore } from '../../modules/seen/seen.store';
import { __resetPrivacySettingsCache, setPrivacySettings } from '../../modules/ui/privacy.store';

// Remembered hosts in the UI: the profile card / hover card fall back to
// what Boson remembers of a nick that has left, and the nick on a
// join/part/quit line shows the host recorded on that line.

const msg = (over: Partial<ChatMessage> = {}): ChatMessage => ({
  id: '1', kind: 'message', from: 'ghost', text: 'boo', timestamp: Date.now(), ...over,
});

function fakeProfiles(seen: SeenStore) {
  const store = signal<ReadonlyMap<string, WhoisInfo>>(new Map());
  const profiles: NickProfiles = {
    info: (n) => store.value.get(n.toLowerCase()),
    request: vi.fn(),
    seen: (n) => seen.get(n),
  };
  const set = (info: WhoisInfo): void => {
    act(() => { store.value = new Map([...store.value, [info.nick.toLowerCase(), info]]); });
  };
  return { profiles, set };
}

const card = (): HTMLElement | null => document.querySelector('.nick-profile-card');

function seenWithGhost(): SeenStore {
  const s = new SeenStore('ui', null, { enabled: () => true });
  s.note('ghost', {
    user: '~WittyQuail', host: '101.128.125.37', account: 'wq', realname: 'Witty Quail',
    channel: '#lobby', at: Date.now() - 2 * 3600_000,
  });
  return s;
}

let matchMedia: typeof window.matchMedia;
beforeEach(() => {
  vi.useFakeTimers();
  matchMedia = window.matchMedia;
  window.matchMedia = ((query: string) => ({
    matches: false, media: query, onchange: null,
    addEventListener: () => {}, removeEventListener: () => {},
    addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
  })) as typeof window.matchMedia;
});
afterEach(() => {
  vi.useRealTimers();
  window.matchMedia = matchMedia;
  document.body.querySelectorAll('.bds-sheet-backdrop, .nick-profile-card, .nick-hovercard-portal').forEach((n) => n.remove());
  localStorage.clear();
  __resetPrivacySettingsCache();
});

describe('profile card: remembered fallback', () => {
  it('a nick that has gone shows the remembered host, account and realname, marked as remembered', () => {
    const { profiles, set } = fakeProfiles(seenWithGhost());
    render(<MessageRow msg={msg()} myNick="me" members={[]} nickActions={{ profiles }} />);
    fireEvent.click(document.querySelector('.message-row-name')!);
    set({ nick: 'ghost', loading: false, notFound: true, requestedAt: 0 });
    const remembered = card()!.querySelector('[data-testid="nick-profile-remembered"]')!;
    expect(remembered.textContent).toContain('Remembered · last seen 2h ago in #lobby');
    expect(remembered.textContent).toContain('~WittyQuail@101.128.125.37');
    expect(remembered.textContent).toContain('wq');
    expect(remembered.textContent).toContain('Witty Quail');
    expect(card()!.textContent).toContain("ghost isn't on the network right now.");
  });

  it('the host can be copied', () => {
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    const { profiles } = fakeProfiles(seenWithGhost());
    render(<MessageRow msg={msg()} myNick="me" members={[]} nickActions={{ profiles }} />);
    fireEvent.click(document.querySelector('.message-row-name')!);
    fireEvent.click(card()!.querySelector('[aria-label="Copy ~WittyQuail@101.128.125.37"]')!);
    expect(writeText).toHaveBeenCalledWith('~WittyQuail@101.128.125.37');
  });

  it('nothing remembered is shown while they are here (live info wins)', () => {
    const ghost: ChatMember = { nick: 'ghost', prefix: '', user: 'g', hostname: 'live.host' };
    const { profiles } = fakeProfiles(seenWithGhost());
    render(<MessageRow msg={msg()} myNick="me" members={[ghost]} nickActions={{ profiles }} />);
    fireEvent.click(document.querySelector('.message-row-name')!);
    expect(card()!.textContent).toContain('ghost!g@live.host');
    expect(card()!.querySelector('[data-testid="nick-profile-remembered"]')).toBeNull();
  });

  it('the hover card falls back too', () => {
    const { profiles } = fakeProfiles(seenWithGhost());
    render(<MessageRow msg={msg()} myNick="me" members={[]} nickActions={{ profiles }} />);
    fireEvent.mouseEnter(document.querySelector('.message-row-name')!);
    act(() => { vi.advanceTimersByTime(200); });
    const hover = document.querySelector('.nick-hovercard-portal')!;
    expect(hover.textContent).toContain('~WittyQuail@101.128.125.37');
    expect(hover.textContent).toContain('last seen 2h ago in #lobby');
  });

  it('with remembering off, nothing is shown', () => {
    setPrivacySettings({ rememberHosts: false });
    const seen = new SeenStore('ui-off');
    act(() => { setPrivacySettings({ rememberHosts: true }); });
    seen.note('ghost', { host: 'h.example', at: Date.now() });
    act(() => { setPrivacySettings({ rememberHosts: false }); });
    const { profiles } = fakeProfiles(seen);
    render(<MessageRow msg={msg()} myNick="me" members={[]} nickActions={{ profiles }} />);
    fireEvent.click(document.querySelector('.message-row-name')!);
    expect(card()!.textContent).not.toContain('h.example');
  });
});

describe('activity lines', () => {
  const quit = (over: Partial<ChatMessage> = {}): ChatMessage => msg({
    id: 'q1', kind: 'quit', from: 'WittyQuail', text: 'WittyQuail quit (bye)',
    user: '~WittyQuail', host: '101.128.125.37', ...over,
  });

  it('a click on the nick shows the host recorded on that line', () => {
    const seen = new SeenStore('ui2', null, { enabled: () => true });
    seen.note('WittyQuail', { user: '~WittyQuail', host: 'later.host', at: Date.now() });
    const { profiles } = fakeProfiles(seen);
    render(<MessageRow msg={quit()} myNick="me" members={[]} nickActions={{ profiles }} />);
    expect(document.querySelector('.message-system-quit .sys-text')!.textContent).toBe('WittyQuail quit (bye)');
    fireEvent.click(document.querySelector('.sys-nick')!);
    const line = card()!.querySelector('[data-testid="nick-profile-line"]')!;
    expect(line.textContent).toContain('When they quit');
    expect(line.textContent).toContain('~WittyQuail@101.128.125.37');
    // …and what we remember now, which differs.
    expect(card()!.querySelector('[data-testid="nick-profile-remembered"]')!.textContent).toContain('~WittyQuail@later.host');
  });

  it('the right-click menu offers to copy the host', () => {
    render(<MessageRow msg={quit()} myNick="me" members={[]} />);
    fireEvent.contextMenu(document.querySelector('.sys-nick')!);
    expect(document.body.textContent).toContain('Copy host');
  });

  it('hosts show inline only with "Show hosts in join/part lines" on', () => {
    render(<MessageRow msg={quit()} myNick="me" members={[]} />);
    expect(document.querySelector('.sys-host')).toBeNull();
    act(() => { setPrivacySettings({ showHostsInActivity: true }); });
    expect(document.querySelector('.sys-text')!.textContent).toBe('WittyQuail (~WittyQuail@101.128.125.37) quit (bye)');
    act(() => { setPrivacySettings({ rememberHosts: false }); });
    expect(document.querySelector('.sys-host')).toBeNull();
  });

  it('inside an expanded folded group, too', () => {
    const items: ChatMessage[] = [
      msg({ id: 'j1', kind: 'join', from: 'a', text: 'a joined', user: 'ua', host: 'a.host', timestamp: 1 }),
      msg({ id: 'j2', kind: 'join', from: 'b', text: 'b joined', user: 'ub', host: 'b.host', timestamp: 2 }),
      msg({ id: 'p1', kind: 'part', from: 'a', text: 'a left', user: 'ua', host: 'a.host', timestamp: 3 }),
      msg({ id: 'q2', kind: 'quit', from: 'b', text: 'b quit', user: 'ub', host: 'b.host', timestamp: 4 }),
    ];
    const messages = signal(items);
    render(<MessageList messages={messages} members={[]} myNick="me" scrollRef={{ current: null }} channelName="#lobby" />);
    fireEvent.click(document.querySelector('.message-activity-toggle')!);
    const nicks = document.querySelectorAll('.message-activity-line .sys-nick');
    expect(nicks.length).toBe(4);
    fireEvent.click(nicks[3]!);
    expect(card()!.querySelector('[data-testid="nick-profile-line"]')!.textContent).toContain('ub@b.host');
  });
});
