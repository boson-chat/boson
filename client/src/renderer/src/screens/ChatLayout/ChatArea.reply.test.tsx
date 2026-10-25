import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen, fireEvent } from '@testing-library/preact';
import { ChatArea } from './ChatArea';
import type { ChatChannel, ChatMessage } from '../../modules/chat';

// A message's Reply (long-press menu on a phone) puts `@nick ` at the front
// of the composer, keeping what was already typed, and focuses it.

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

function renderChat(messages: ChatMessage[]) {
  render(
    <ChatArea channel={chan(messages)} myNick="alice" onSend={vi.fn()} nickActions={{ onSendMessage: vi.fn() }} />,
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
  document.body.querySelectorAll('.bottom-sheet-backdrop').forEach((n) => n.remove());
});

describe('ChatArea — Reply', () => {
  it('puts @nick at the front of the composer and focuses it', () => {
    renderChat([msg()]);
    replyTo('anyone around?');
    expect(box().value).toBe('@bob ');
    expect(document.activeElement).toBe(box());
  });

  it('keeps what was already typed', () => {
    renderChat([msg()]);
    fireEvent.input(box(), { target: { value: 'yes, here' } });
    replyTo('anyone around?');
    expect(box().value).toBe('@bob yes, here');
  });

  it('does not tag the same nick twice', () => {
    renderChat([msg(), msg({ id: 'm2', text: 'hello?' })]);
    replyTo('anyone around?');
    replyTo('hello?');
    expect(box().value).toBe('@bob ');
  });
});
