import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/preact';
import { ChatArea } from './ChatArea';
import { findMatches } from './ChatSearch';
import type { ChatChannel, ChatMessage } from '../../modules/chat';

// In-conversation search: the header's search button (or Ctrl/Cmd+F) opens
// a bar that finds the query in the loaded messages, marks their rows, and
// steps through them; with server history it offers to load older ones.

let n = 0;
const msg = (text: string, over: Partial<ChatMessage> = {}): ChatMessage => ({
  id: `m${++n}`, kind: 'message', from: 'bob', text, timestamp: 1_700_000_000_000 + n * 1000, ...over,
});

const chan = (messages: ChatMessage[], over: Partial<ChatChannel> = {}): ChatChannel => ({
  name: '#general', joined: true, members: [], messages, typing: [],
  unread: 0, mentions: 0, topic: '', ...over,
});

afterEach(() => { n = 0; });

describe('findMatches', () => {
  it('finds the query in message text, any case, formatting stripped, oldest first', () => {
    const ms = [
      msg('Deploy went fine'),
      msg('\x02deploy\x02 again?'),
      msg('nothing here'),
      msg('deploys', { kind: 'action' }),
      msg('bob joined: deploy', { kind: 'join' }),
    ];
    expect(findMatches(ms, 'DEPLOY')).toEqual(['m1', 'm2', 'm4']);
    expect(findMatches(ms, '  ')).toEqual([]);
    expect(findMatches(ms, 'zzz')).toEqual([]);
  });
});

function renderChat(messages: ChatMessage[], props: Partial<Parameters<typeof ChatArea>[0]> = {}) {
  return render(<ChatArea channel={chan(messages)} myNick="alice" onSend={vi.fn()} {...props} />);
}
const field = (): HTMLInputElement => screen.getByRole('searchbox', { name: 'Search this conversation' }) as HTMLInputElement;
const count = (): string => document.querySelector('.chat-search-count')!.textContent ?? '';

describe('ChatArea — search', () => {
  it('opens from the header, counts matches and starts at the newest', () => {
    renderChat([msg('alpha one'), msg('beta'), msg('alpha two')]);
    fireEvent.click(screen.getByRole('button', { name: 'Search this conversation' }));
    expect(document.activeElement).toBe(field());
    fireEvent.input(field(), { target: { value: 'alpha' } });
    expect(count()).toBe('2 of 2');
    expect(document.querySelectorAll('.vrow-search-match')).toHaveLength(2);
    const current = document.querySelector('.vrow-search-current')!;
    expect(current.textContent).toContain('alpha two');
  });

  it('steps to older and newer matches, wrapping round', () => {
    renderChat([msg('alpha one'), msg('beta'), msg('alpha two')]);
    fireEvent.click(screen.getByRole('button', { name: 'Search this conversation' }));
    fireEvent.input(field(), { target: { value: 'alpha' } });
    fireEvent.click(screen.getByRole('button', { name: 'Older match' }));
    expect(count()).toBe('1 of 2');
    expect(document.querySelector('.vrow-search-current')!.textContent).toContain('alpha one');
    fireEvent.keyDown(field(), { key: 'Enter' });
    expect(count()).toBe('2 of 2');
    fireEvent.keyDown(field(), { key: 'Enter', shiftKey: true });
    expect(count()).toBe('1 of 2');
    fireEvent.click(screen.getByRole('button', { name: 'Newer match' }));
    expect(count()).toBe('2 of 2');
  });

  it('says when nothing matches', () => {
    renderChat([msg('alpha')]);
    fireEvent.click(screen.getByRole('button', { name: 'Search this conversation' }));
    fireEvent.input(field(), { target: { value: 'zzz' } });
    expect(count()).toBe('No matches');
    expect((screen.getByRole('button', { name: 'Older match' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('Ctrl+F opens it; Escape closes it and clears the marks', () => {
    renderChat([msg('alpha')]);
    fireEvent.keyDown(window, { key: 'f', ctrlKey: true });
    fireEvent.input(field(), { target: { value: 'alpha' } });
    expect(document.querySelectorAll('.vrow-search-match')).toHaveLength(1);
    fireEvent.keyDown(field(), { key: 'Escape' });
    expect(screen.queryByRole('search')).toBeNull();
    expect(document.querySelectorAll('.vrow-search-match')).toHaveLength(0);
  });

  it('Ctrl+F leaves a field outside the chat alone', () => {
    renderChat([msg('alpha')]);
    const other = document.createElement('input');
    document.body.appendChild(other);
    other.focus();
    fireEvent.keyDown(window, { key: 'f', ctrlKey: true });
    expect(screen.queryByRole('search')).toBeNull();
    other.remove();
  });

  it('with server history: offers to load older messages to search', () => {
    const onLoadOlder = vi.fn();
    renderChat([msg('alpha')], { onLoadOlder, serverInfo: { scrollbackAvailable: true } });
    fireEvent.click(screen.getByRole('button', { name: 'Search this conversation' }));
    expect(screen.getByText('Searching the messages loaded so far.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Search older messages' }));
    expect(onLoadOlder).toHaveBeenCalledWith('#general');
  });

  it('without server history: no load-older offer', () => {
    renderChat([msg('alpha')]);
    fireEvent.click(screen.getByRole('button', { name: 'Search this conversation' }));
    expect(screen.queryByText('Searching the messages loaded so far.')).toBeNull();
  });
});
