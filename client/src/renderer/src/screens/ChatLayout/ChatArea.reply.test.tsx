import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen, fireEvent } from '@testing-library/preact';
import { ChatArea } from './ChatArea';
import type { ChatChannel, ChatMessage } from '../../modules/chat';

// A message's Reply (long-press menu on a phone) opens the "Replying to"
// bar over the composer, on every server: the line sent answers it (with
// the IRCv3 tag where the server has message-tags, and always with the
// `nick: ` text form, added by ChatService.send).

const msg = (over: Partial<ChatMessage> = {}): ChatMessage => ({
  id: 'm1', kind: 'message', from: 'bob', text: 'anyone around?', timestamp: Date.now(), ...over,
});

const chan = (messages: ChatMessage[]): ChatChannel => ({
  name: '#general', joined: true, members: [], messages, typing: [],
  unread: 0, mentions: 0, topic: '',
});

function phoneWidth(matches: boolean): void {
  window.matchMedia = ((query: string) => ({
    matches, media: query, onchange: null,
    addEventListener: () => {}, removeEventListener: () => {},
    addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
  })) as typeof window.matchMedia;
}

function replyTo(text: string): void {
  const row = screen.getByText(text).closest('.message-row')!;
  fireEvent.touchStart(row, { touches: [{ clientX: 10, clientY: 10 }] });
  act(() => { vi.advanceTimersByTime(500); });
  fireEvent.touchEnd(row, { touches: [] });
  fireEvent.click(screen.getByRole('menuitem', { name: 'Reply' }));
  act(() => { vi.advanceTimersByTime(400); });
}

const box = (): HTMLTextAreaElement => document.querySelector('.chat-textarea') as HTMLTextAreaElement;

function renderChat(messages: ChatMessage[], opts: { caps?: string[]; onSend?: (message: string, opts?: { replyTo?: string; replyToId?: string }) => void } = {}) {
  render(
    <ChatArea
      channel={chan(messages)}
      myNick="alice"
      onSend={opts.onSend ?? vi.fn()}
      nickActions={{ onSendMessage: vi.fn() }}
      serverInfo={opts.caps ? { enabledCaps: opts.caps } : undefined}
    />,
  );
}

let matchMedia: typeof window.matchMedia;
beforeEach(() => {
  vi.useFakeTimers();
  matchMedia = window.matchMedia;
  phoneWidth(true);
});
afterEach(() => {
  vi.useRealTimers();
  window.matchMedia = matchMedia;
  document.body.querySelectorAll('.bds-sheet-backdrop').forEach((n) => n.remove());
});

describe('ChatArea — Reply', () => {
  it('opens the reply bar and focuses the composer, keeping what was typed', () => {
    renderChat([msg()]);
    fireEvent.input(box(), { target: { value: 'yes, here' } });
    replyTo('anyone around?');
    expect(document.querySelector('.chat-reply-bar')?.textContent).toContain('Replying to bob');
    expect(box().value).toBe('yes, here');
    expect(document.activeElement).toBe(box());
  });

  it('a second Reply switches the target', () => {
    renderChat([msg(), msg({ id: 'm2', text: 'hello?' })]);
    replyTo('anyone around?');
    replyTo('hello?');
    expect(document.querySelector('.chat-reply-bar-excerpt')?.textContent).toBe('hello?');
  });
});

// IRCv3 replies: where the server negotiated message-tags and the message
// has a msgid, Reply opens a "Replying to" bar and the next line goes out
// with that msgid; Escape or × cancels.
describe('ChatArea — quoted replies', () => {
  const tagged = (over: Partial<ChatMessage> = {}) => msg({ msgid: 'abc', ...over });

  it('shows "Replying to" and sends the next line as a reply', () => {
    const onSend = vi.fn();
    renderChat([tagged()], { caps: ['message-tags'], onSend });
    replyTo('anyone around?');
    const bar = document.querySelector('.chat-reply-bar')!;
    expect(bar.textContent).toContain('Replying to bob');
    expect(bar.textContent).toContain('anyone around?');
    // No @nick: the quote says who it answers.
    expect(box().value).toBe('');
    expect(document.activeElement).toBe(box());
    fireEvent.input(box(), { target: { value: 'yes!' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(onSend).toHaveBeenCalledWith('yes!', { replyTo: 'abc', replyToId: 'm1' });
    expect(document.querySelector('.chat-reply-bar')).toBeNull();
  });

  it('only the first line of a multi-line send carries the reply', () => {
    const onSend = vi.fn();
    renderChat([tagged()], { caps: ['message-tags'], onSend });
    replyTo('anyone around?');
    fireEvent.input(box(), { target: { value: 'one\ntwo' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(onSend.mock.calls).toEqual([['one', { replyTo: 'abc', replyToId: 'm1' }], ['two']]);
  });

  it('Escape in the composer cancels the reply', () => {
    renderChat([tagged()], { caps: ['message-tags'] });
    replyTo('anyone around?');
    fireEvent.keyDown(box(), { key: 'Escape' });
    expect(document.querySelector('.chat-reply-bar')).toBeNull();
  });

  it('the bar\'s × cancels it too', () => {
    const onSend = vi.fn();
    renderChat([tagged()], { caps: ['message-tags'], onSend });
    replyTo('anyone around?');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel reply' }));
    expect(document.querySelector('.chat-reply-bar')).toBeNull();
    fireEvent.input(box(), { target: { value: 'plain' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(onSend).toHaveBeenCalledWith('plain');
  });

  it('without message-tags (ngircd) it is still a reply, by its local id', () => {
    const onSend = vi.fn();
    renderChat([msg()], { caps: ['server-time'], onSend });
    replyTo('anyone around?');
    expect(document.querySelector('.chat-reply-bar')?.textContent).toContain('Replying to bob');
    expect(box().value).toBe('');
    fireEvent.input(box(), { target: { value: 'yep' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(onSend).toHaveBeenCalledWith('yep', { replyToId: 'm1' });
  });

  it('your own line can be replied to once it has a msgid (echo-message), not before', () => {
    phoneWidth(false);
    renderChat([
      tagged({ id: 'm1', from: 'alice', text: 'mine, echoed', msgid: 'own1' }),
      msg({ id: 'm2', from: 'alice', text: 'mine, no msgid', timestamp: Date.now() + 600_000 }),
    ], { caps: ['message-tags', 'echo-message'] });
    const rowOf = (t: string) => screen.getByText(t).closest('.message-row')!;
    expect(rowOf('mine, no msgid').querySelector('[aria-label="Reply"]')).toBeNull();
    fireEvent.click(rowOf('mine, echoed').querySelector('[aria-label="Reply"]')!);
    expect(document.querySelector('.chat-reply-bar')?.textContent).toContain('Replying to alice');
  });

  it('desktop: the hover toolbar\'s Reply starts a reply', () => {
    phoneWidth(false);
    renderChat([tagged()], { caps: ['message-tags'] });
    fireEvent.click(screen.getByRole('button', { name: 'Reply' }));
    expect(document.querySelector('.chat-reply-bar')?.textContent).toContain('Replying to bob');
  });
});

describe('ChatArea — reply quotes', () => {
  it('a reply shows who it answers and a line of what they said', () => {
    renderChat([
      msg({ msgid: 'p1', text: 'the **original** question\nwith a second line' }),
      msg({ id: 'm2', from: 'carol', text: 'answer', msgid: 'r1', replyTo: 'p1' }),
    ]);
    const quote = document.querySelector('.message-reply-quote')!;
    expect(quote.tagName).toBe('BUTTON');
    expect(quote.querySelector('.message-reply-quote-author')!.textContent).toBe('bob');
    expect(quote.querySelector('.message-reply-quote-text')!.textContent).toBe('the **original** question with a second line');
  });

  it('says so when the original isn\'t loaded (and there is no history to ask)', () => {
    renderChat([msg({ id: 'm2', from: 'carol', text: 'answer', replyTo: 'gone' })]);
    const quote = document.querySelector('.message-reply-quote')!;
    expect(quote.tagName).toBe('DIV');
    expect(quote.textContent).toBe('Original message not available');
  });

  it('hides the `nick: "quote..." ` the quote stands for', () => {
    renderChat([
      msg({ msgid: 'p1', text: 'anyone know why the build fails on arm?' }),
      msg({ id: 'm2', text: 'anyone around?', timestamp: Date.now() + 1 }),
      msg({ id: 'm3', from: 'carol', text: 'bob: "anyone know..." it\'s libssl-dev', msgid: 'r1', replyTo: 'p1', timestamp: Date.now() + 2 }),
    ]);
    const row = document.querySelector('.message-reply-quote')!.closest('.message-row')!;
    expect(row.querySelector('.message-row-text-body')!.textContent).toBe("it's libssl-dev");
  });

  it('a guess stored by an older version shows no quote: just the line', () => {
    renderChat([
      msg({ text: 'is the relay up?' }),
      msg({ id: 'm2', from: 'carol', text: 'bob: yes', replyToId: 'm1', replyGuess: true, timestamp: Date.now() + 1 }),
    ]);
    expect(document.querySelector('.message-reply-quote')).toBeNull();
    expect(screen.getByText('bob: yes')).toBeTruthy();
  });

  it('a plain mention line gets no reply quote', () => {
    renderChat([
      msg({ from: 'TheLion', text: 'sup' }),
      msg({ id: 'm2', from: 'thelion_evrd', text: 'TheLion: hi', timestamp: Date.now() + 1 }),
    ]);
    expect(document.querySelector('.message-reply-quote')).toBeNull();
  });

  it('a reply to one of your lines is highlighted as a mention', () => {
    renderChat([
      msg({ from: 'alice', text: 'deploy done', msgid: 'mine' }),
      msg({ id: 'm2', from: 'carol', text: 'great', replyTo: 'mine', timestamp: Date.now() + 1 }),
    ]);
    expect(screen.getByText('great').closest('.message-row')!.classList.contains('message-row-mention')).toBe(true);
  });
});
