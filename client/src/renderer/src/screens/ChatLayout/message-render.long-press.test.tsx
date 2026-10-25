import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen, fireEvent } from '@testing-library/preact';
import { MessageRow } from './message-render';
import type { ChatMessage } from '../../modules/chat';

function makeMsg(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return { id: '1', kind: 'message', from: 'alice', text: 'hello \x02there\x02', timestamp: Date.now(), ...overrides };
}

function phoneWidth(matches: boolean): void {
  window.matchMedia = ((query: string) => ({
    matches, media: query, onchange: null,
    addEventListener: () => {}, removeEventListener: () => {},
    addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
  })) as typeof window.matchMedia;
}

function longPress(el: Element, ms = 500): void {
  fireEvent.touchStart(el, { touches: [{ clientX: 10, clientY: 10 }] });
  act(() => { vi.advanceTimersByTime(ms); });
  fireEvent.touchEnd(el, { touches: [] });
}

let matchMedia: typeof window.matchMedia;
beforeEach(() => {
  vi.useFakeTimers();
  matchMedia = window.matchMedia;
});
afterEach(() => {
  vi.useRealTimers();
  window.matchMedia = matchMedia;
  document.body.querySelectorAll('.bottom-sheet-backdrop').forEach((n) => n.remove());
});

describe('MessageRow long press (phone)', () => {
  it('opens the message sheet with Reply, Copy text and a DM', () => {
    phoneWidth(true);
    const onMention = vi.fn();
    const onSendMessage = vi.fn();
    render(<MessageRow msg={makeMsg()} myNick="me" members={[]} nickActions={{ onMention, onSendMessage }} />);
    longPress(document.querySelector('.message-row')!);

    const sheet = document.querySelector('.bottom-sheet')!;
    expect(sheet).not.toBeNull();
    expect(sheet.textContent).toContain('hello there');
    const labels = screen.getAllByRole('menuitem').map((b) => b.textContent);
    expect(labels).toEqual(['Reply', 'Copy text', 'Message alice', 'View profile']);

    fireEvent.click(screen.getByRole('menuitem', { name: 'Reply' }));
    expect(onMention).toHaveBeenCalledWith('alice');
  });

  it('copies the text without IRC formatting', () => {
    phoneWidth(true);
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    render(<MessageRow msg={makeMsg()} myNick="me" members={[]} />);
    longPress(document.querySelector('.message-row')!);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Copy text' }));
    expect(writeText).toHaveBeenCalledWith('hello there');
  });

  it('offers no Reply or DM on your own message', () => {
    phoneWidth(true);
    render(
      <MessageRow msg={makeMsg({ from: 'me' })} myNick="me" members={[]}
        nickActions={{ onMention: vi.fn(), onSendMessage: vi.fn() }} />,
    );
    longPress(document.querySelector('.message-row')!);
    expect(screen.getAllByRole('menuitem').map((b) => b.textContent)).toEqual(['Copy text', 'View profile']);
  });

  it('a short tap or a scroll does not open it', () => {
    phoneWidth(true);
    render(<MessageRow msg={makeMsg()} myNick="me" members={[]} />);
    const row = document.querySelector('.message-row')!;
    longPress(row, 200);
    fireEvent.touchStart(row, { touches: [{ clientX: 10, clientY: 10 }] });
    fireEvent.touchMove(row, { touches: [{ clientX: 10, clientY: 60 }] });
    act(() => { vi.advanceTimersByTime(600); });
    expect(document.querySelector('.bottom-sheet')).toBeNull();
  });

  it('does nothing on a desktop-width window', () => {
    phoneWidth(false);
    render(<MessageRow msg={makeMsg()} myNick="me" members={[]} />);
    longPress(document.querySelector('.message-row')!);
    expect(document.querySelector('.bottom-sheet')).toBeNull();
  });
});
