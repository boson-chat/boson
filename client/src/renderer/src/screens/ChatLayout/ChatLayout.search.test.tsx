// The full-page search in the chat layout, over a real ChatService: the
// header's Search and Ctrl/Cmd+F open it in place of the conversation (the
// member list making way on desktop), Older results asks the server
// (CHATHISTORY BEFORE) without touching the conversation, and a result
// opened goes to the conversation with Back to results / Jump to latest.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { ChatLayout } from './ChatLayout';
import { ChatService } from '../../modules/chat';
import type { EventListener, IrcEvent, ServerSession } from '../../modules/engine';
import { NARROW_QUERY } from '../../shared/narrow';
import { clearSearchSessions } from '../../modules/search/search-session';
import { setFriendsUi } from '../Friends/friends-ui';

function setWidth(phone: boolean): void {
  window.matchMedia = ((query: string) => ({
    matches: phone ? query === NARROW_QUERY : query === '(min-width: 1200px)', media: query, onchange: null,
    addEventListener: () => {}, removeEventListener: () => {},
    addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
  })) as typeof window.matchMedia;
}

const BASE = Date.parse('2026-11-01T00:00:00Z');

function setup() {
  let listener: EventListener | null = null;
  const noop = () => {};
  const raws: string[] = [];
  const session = {
    serverId: 'srv', join: noop, part: noop, names: noop, tagmsg: noop, list: noop, away: noop,
    nick: noop, nickservIdentify: noop, privmsg: noop,
    raw: (l: string) => { raws.push(l); },
    onEvent: (fn: EventListener) => { listener = fn; return () => { listener = null; }; },
    onChannelDirectory: () => noop, onServicesFramework: () => noop, servicesFramework: () => null,
  } as unknown as ServerSession;
  const chat = new ChatService(session, 'me');
  chat.attach();
  const emit = (e: Partial<IrcEvent> & Pick<IrcEvent, 'Kind'>) => act(() => { listener?.({ From: '', Target: '', Message: '', Raw: '', ...e }); });
  emit({ Kind: 'CAP', Message: 'batch server-time message-tags chathistory', Args: ['ACK'] });
  emit({ Kind: '001', From: 'irc.test', Target: 'me' });
  emit({ Kind: 'JOIN', From: 'me', Target: '#infra' });
  emit({ Kind: '353', Target: '#infra', Message: '@kestrel me' });
  emit({ Kind: '366', Target: '#infra' });
  const batch = (ref: string, lines: Array<[number, string, string]>) => {
    emit({ Kind: 'BATCH', Args: [`+${ref}`, 'chathistory', '#infra'] });
    for (const [i, from, text] of lines) {
      emit({ Kind: 'PRIVMSG', From: from, Target: '#infra', Message: text, Tags: { batch: ref, time: new Date(BASE + i * 60_000).toISOString(), msgid: `id${i}` } });
    }
    emit({ Kind: 'BATCH', Args: [`-${ref}`] });
  };
  // The join's backlog: 50 recent lines (a full page: more is older).
  batch('latest', Array.from({ length: 50 }, (_, k) => [1000 + k, 'kestrel', k === 10 ? 'the dns record is fixed' : `chatter ${k}`]));
  chat.setActive('#infra');
  const r = render(<ChatLayout chat={chat} serverName="local" myNick="me" activeServerId="srv" onBrowseServers={() => {}} />);
  const shown = () => chat.getState().channels.find((c) => c.name === '#infra')!.messages.map((m) => m.text);
  return { ...r, chat, emit, batch, raws, shown };
}

let matchMedia: typeof window.matchMedia;
beforeEach(() => { matchMedia = window.matchMedia; clearSearchSessions(); });
afterEach(() => { window.matchMedia = matchMedia; setFriendsUi({ phone: null }); });

const count = () => document.querySelector('.search-count') as HTMLElement;
const searchBox = () => screen.getByRole('searchbox', { name: 'Search messages' });
const typeQuery = async (text: string) => {
  fireEvent.input(searchBox(), { target: { value: text } });
  await waitFor(() => expect(count()).not.toHaveTextContent(/^$/));
};

describe('ChatLayout: the search page', () => {
  it('desktop: Search opens it in place of the conversation (members make way); Esc closes it', async () => {
    setWidth(false);
    setup();
    expect(screen.getByRole('complementary', { name: /Members/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Search this conversation' }));
    expect(screen.getByRole('region', { name: 'Search in #infra' })).toBeInTheDocument();
    expect(searchBox()).toHaveFocus();
    expect(screen.queryByRole('complementary', { name: /Members/ })).toBeNull();
    // The conversation stays (its place kept), inert under the page.
    expect(document.querySelector('.chat-area-conv')).toHaveAttribute('inert');
    fireEvent.keyDown(searchBox(), { key: 'Escape' });
    expect(screen.queryByRole('region', { name: 'Search in #infra' })).toBeNull();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Search this conversation' })).toHaveFocus());
    expect(screen.getByRole('complementary', { name: /Members/ })).toBeInTheDocument();
  });

  it('Ctrl/Cmd+F opens it', () => {
    setWidth(false);
    setup();
    fireEvent.keyDown(window, { key: 'f', ctrlKey: true });
    expect(screen.getByRole('region', { name: 'Search in #infra' })).toBeInTheDocument();
  });

  it('Older results asks the server and keeps what comes out of the conversation; the query never goes', async () => {
    setWidth(false);
    const t = setup();
    fireEvent.click(screen.getByRole('button', { name: 'Search this conversation' }));
    await typeQuery('dns');
    expect(count()).toHaveTextContent('1 result');
    const before = t.shown();
    fireEvent.click(screen.getByRole('button', { name: 'Older results' }));
    const sent = t.raws.filter((l) => l.startsWith('CHATHISTORY BEFORE'));
    expect(sent).toEqual([`CHATHISTORY BEFORE #infra timestamp=${new Date(BASE + 1000 * 60_000).toISOString()} 100`]);
    expect(t.raws.some((l) => /dns/i.test(l))).toBe(false);
    t.batch('s1', [[10, 'mox', 'old dns notes'], [11, 'mox', 'more']]);
    await waitFor(() => expect(count()).toHaveTextContent('2 results'));
    expect(t.shown()).toEqual(before);
  });

  it('phone: a result opens in the conversation; Back to results returns to the same page; Jump to latest leaves', async () => {
    setWidth(true);
    setFriendsUi({ phone: 'chat' });
    const t = setup();
    fireEvent.click(screen.getByRole('button', { name: 'Search in #infra' }));
    await typeQuery('dns');
    fireEvent.click(screen.getByRole('button', { name: 'Older results' }));
    t.batch('s1', [[10, 'mox', 'old dns notes'], [11, 'mox', 'more']]);
    await waitFor(() => expect(count()).toHaveTextContent('2 results'));
    expect(t.shown()).not.toContain('old dns notes');

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /old dns notes/ })); });
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Search in #infra' })).toBeNull());
    // Now in the conversation, with what's between it and the rest.
    expect(t.shown()).toContain('old dns notes');
    expect(t.shown()).toContain('more');
    expect(screen.getByRole('button', { name: 'Back to results' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Jump to latest' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Back to results' }));
    expect(searchBox()).toHaveValue('dns');
    expect(count()).toHaveTextContent('2 results');
    fireEvent.click(screen.getByRole('button', { name: 'Back to #infra' }));
    expect(screen.queryByRole('button', { name: 'Back to results' })).toBeNull();

    // Again, then Jump to latest.
    fireEvent.click(screen.getByRole('button', { name: 'Search in #infra' }));
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /old dns notes/ })); });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Jump to latest' })).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Jump to latest' }));
    expect(screen.queryByRole('button', { name: 'Back to results' })).toBeNull();
  });
});
