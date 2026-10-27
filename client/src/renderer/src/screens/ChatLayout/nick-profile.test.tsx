import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen, fireEvent } from '@testing-library/preact';
import { signal } from '@preact/signals';
import { MessageRow } from './message-render';
import { UserPanel } from './UserPanel';
import { profileRows } from './nick-profile';
import type { NickProfiles } from './nick-actions';
import type { ChatChannel, ChatMember, ChatMessage, WhoisInfo } from '../../modules/chat';

// A click on a nick — a message's author or avatar, a mention in the text,
// or a row in the member list — opens their profile: a card on desktop, the
// nick sheet on a phone. Opening it asks for a WHOIS, and the card fills in
// as the replies land.

const bob: ChatMember = {
  nick: 'bob', prefix: '@', user: '~bob', hostname: 'user/bob', realname: 'Bob Builder', server: 'irc.example.net',
};

const msg = (over: Partial<ChatMessage> = {}): ChatMessage => ({
  id: '1', kind: 'message', from: 'bob', text: 'hello', timestamp: Date.now(), ...over,
});

function fakeProfiles() {
  const store = signal<ReadonlyMap<string, WhoisInfo>>(new Map());
  const request = vi.fn();
  const profiles: NickProfiles = { info: (n) => store.value.get(n.toLowerCase()), request };
  const set = (info: WhoisInfo): void => {
    act(() => { store.value = new Map([...store.value, [info.nick.toLowerCase(), info]]); });
  };
  return { profiles, request, set };
}

function phoneWidth(matches: boolean): void {
  window.matchMedia = ((query: string) => ({
    matches, media: query, onchange: null,
    addEventListener: () => {}, removeEventListener: () => {},
    addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
  })) as typeof window.matchMedia;
}

const card = (): HTMLElement | null => document.querySelector('.nick-profile-card');

let matchMedia: typeof window.matchMedia;
beforeEach(() => {
  vi.useFakeTimers();
  matchMedia = window.matchMedia;
  phoneWidth(false);
});
afterEach(() => {
  vi.useRealTimers();
  window.matchMedia = matchMedia;
  document.body.querySelectorAll('.bottom-sheet-backdrop, .nick-profile-card').forEach((n) => n.remove());
});

describe('profileRows', () => {
  it('shows the mask, realname, server and account from the member record', () => {
    const rows = profileRows('bob', { ...bob, account: 'bobacct' });
    expect(rows.map((r) => [r.label, r.value])).toEqual([
      ['Mask', 'bob!~bob@user/bob'],
      ['Real name', 'Bob Builder'],
      ['Account', 'bobacct'],
      ['Server', 'irc.example.net'],
    ]);
  });

  it('a finished WHOIS adds what only it knows, and says when there is no account', () => {
    const rows = profileRows('bob', bob, {
      nick: 'bob', loading: false, requestedAt: 0,
      secure: true, idleSeconds: 90, channels: ['@#ops', '#general'], actualHost: '203.0.113.7', serverInfo: 'Example, EU',
    });
    const byLabel = Object.fromEntries(rows.map((r) => [r.label, r]));
    expect(byLabel.Account!.value).toBe('Not logged in');
    expect(byLabel.Connection!.value).toBe('Secure (TLS)');
    expect(byLabel.Idle!.value).toBe('1m');
    expect(byLabel.Channels!.value).toBe('@#ops #general');
    expect(byLabel['Real host']!.value).toBe('203.0.113.7');
    expect(byLabel.Server!.title).toBe('Example, EU');
  });

  it('no "Not logged in" while the WHOIS is still out', () => {
    const rows = profileRows('bob', bob, { nick: 'bob', loading: true, requestedAt: 0 });
    expect(rows.find((r) => r.label === 'Account')).toBeUndefined();
  });
});

describe('Profile card (desktop)', () => {
  it('a click on the author opens it, asks for a WHOIS and fills in', () => {
    const { profiles, request, set } = fakeProfiles();
    render(<MessageRow msg={msg()} myNick="me" members={[bob]} nickActions={{ profiles, onSendMessage: vi.fn() }} />);
    fireEvent.click(document.querySelector('.message-row-name')!);

    expect(card()).not.toBeNull();
    expect(screen.getByRole('dialog', { name: 'bob' })).toBe(card());
    expect(request).toHaveBeenCalledWith('bob');
    expect(card()!.textContent).toContain('bob!~bob@user/bob');
    expect(card()!.textContent).toContain('Operator');

    set({ nick: 'bob', loading: true, requestedAt: 0 });
    expect(card()!.textContent).toContain('Looking up bob…');
    set({ nick: 'bob', loading: false, requestedAt: 0, account: 'bobacct', oper: 'is an IRC operator', secure: true });
    expect(card()!.textContent).not.toContain('Looking up');
    expect(card()!.textContent).toContain('bobacct');
    expect(card()!.textContent).toContain('IRC operator');
    expect(card()!.textContent).toContain('Secure (TLS)');
  });

  it('offers the nick actions, and closes after one', () => {
    const onSendMessage = vi.fn();
    render(<MessageRow msg={msg()} myNick="me" members={[bob]} nickActions={{ onSendMessage }} />);
    fireEvent.click(document.querySelector('.message-avatar-btn')!);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Send message' }));
    expect(onSendMessage).toHaveBeenCalledWith('bob');
    expect(card()).toBeNull();
  });

  it('closes on Escape and on a click elsewhere', () => {
    render(<MessageRow msg={msg()} myNick="me" members={[bob]} />);
    fireEvent.click(document.querySelector('.message-row-name')!);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(card()).toBeNull();
    fireEvent.click(document.querySelector('.message-row-name')!);
    fireEvent.mouseDown(document.body);
    expect(card()).toBeNull();
  });

  it('a mention in the text opens the mentioned nick, as the member list spells it', () => {
    const { profiles, request } = fakeProfiles();
    render(
      <MessageRow msg={msg({ from: 'carol', text: 'ask @BOB about it' })} myNick="me" members={[bob]} nickActions={{ profiles }} />,
    );
    const mention = document.querySelector('.message-row-text .chat-token-mention')!;
    expect(mention.getAttribute('data-nick')).toBe('bob');
    fireEvent.click(mention);
    expect(screen.getByRole('dialog', { name: 'bob' })).toBeTruthy();
    expect(request).toHaveBeenCalledWith('bob');
  });

  it("says when the nick isn't on the network any more", () => {
    const { profiles, set } = fakeProfiles();
    render(<MessageRow msg={msg({ from: 'ghost' })} myNick="me" members={[]} nickActions={{ profiles }} />);
    fireEvent.click(document.querySelector('.message-row-name')!);
    set({ nick: 'ghost', loading: false, notFound: true, requestedAt: 0 });
    expect(card()!.textContent).toContain("ghost isn't on the network right now.");
  });

  it('a click on a member in the list opens it too', () => {
    const { profiles, request } = fakeProfiles();
    const channel: ChatChannel = {
      name: '#general', joined: true, members: [bob], messages: [], typing: [], unread: 0, mentions: 0, topic: '',
    };
    render(<UserPanel channel={channel} nickActions={{ profiles }} />);
    fireEvent.click(document.querySelector('.user-panel-item')!);
    expect(screen.getByRole('dialog', { name: 'bob' })).toBe(card());
    expect(request).toHaveBeenCalledWith('bob');
  });
});

describe('Profile on a phone', () => {
  it('a tap on a mention opens the nick sheet with the WHOIS', () => {
    phoneWidth(true);
    const { profiles, request, set } = fakeProfiles();
    render(<MessageRow msg={msg({ from: 'carol', text: 'bob: hi' })} myNick="me" members={[bob]} nickActions={{ profiles }} />);
    fireEvent.click(document.querySelector('.chat-token-mention')!);
    expect(card()).toBeNull();
    const sheet = document.querySelector('.bottom-sheet')!;
    expect(sheet.getAttribute('aria-label')).toBe('bob');
    expect(request).toHaveBeenCalledWith('bob');
    set({ nick: 'bob', loading: false, requestedAt: 0, channels: ['#general', '#boson'] });
    expect(sheet.textContent).toContain('#general #boson');
  });
});

describe('Hover cards stay inside the window', () => {
  const CARD_H = 180;
  let offsetHeight: PropertyDescriptor | undefined;
  let innerHeight: number;
  beforeEach(() => {
    offsetHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight');
    Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, get: () => CARD_H });
    innerHeight = window.innerHeight;
    window.innerHeight = 600;
  });
  afterEach(() => {
    if (offsetHeight) Object.defineProperty(HTMLElement.prototype, 'offsetHeight', offsetHeight);
    window.innerHeight = innerHeight;
    document.body.querySelectorAll('.nick-hovercard-portal').forEach((n) => n.remove());
  });

  const rowAt = (el: Element, top: number): void => {
    el.getBoundingClientRect = () => ({ top, bottom: top + 20, left: 900, right: 1100, width: 200, height: 20, x: 900, y: top, toJSON: () => ({}) });
  };
  const hoverCardTop = (): number => parseFloat(document.querySelector<HTMLElement>('[role="tooltip"]')!.style.top);

  it('a member near the bottom pushes the card up', () => {
    const channel: ChatChannel = {
      name: '#general', joined: true, members: [bob], messages: [], typing: [], unread: 0, mentions: 0, topic: '',
    };
    render(<UserPanel channel={channel} />);
    const row = document.querySelector('.user-panel-item')!;
    rowAt(row, 570);
    fireEvent.mouseEnter(row);
    act(() => { vi.advanceTimersByTime(200); });
    expect(hoverCardTop()).toBe(600 - CARD_H - 8);
  });

  it('a nick in a message near the bottom puts the card above it', () => {
    render(<MessageRow msg={msg()} myNick="me" members={[bob]} />);
    const name = document.querySelector('.message-row-name')!;
    rowAt(name, 560);
    fireEvent.mouseEnter(name);
    act(() => { vi.advanceTimersByTime(1000); });
    expect(hoverCardTop()).toBe(560 - 6 - CARD_H);
  });

  it('one with room below opens below', () => {
    render(<MessageRow msg={msg()} myNick="me" members={[bob]} />);
    const name = document.querySelector('.message-row-name')!;
    rowAt(name, 100);
    fireEvent.mouseEnter(name);
    act(() => { vi.advanceTimersByTime(1000); });
    expect(hoverCardTop()).toBe(124);
  });
});
