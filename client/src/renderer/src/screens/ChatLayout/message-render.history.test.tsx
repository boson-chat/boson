import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/preact';
import { createRef } from 'preact';
import { signal } from '@preact/signals';
import type { ChatMessage } from '../../modules/chat';
import { MessageList } from './message-render';

function renderList(over: Partial<Parameters<typeof MessageList>[0]> = {}) {
  return render(
    <MessageList
      messages={signal<ChatMessage[]>([])}
      members={[]}
      myNick="me"
      scrollRef={createRef()}
      channelName="#t"
      {...over}
    />,
  );
}

describe('MessageList — load older (chathistory)', () => {
  it('shows the "Load older messages" button when supported and not exhausted', () => {
    const onLoadOlder = vi.fn();
    renderList({ historySupported: true, historyExhausted: false, onLoadOlder });
    const btn = screen.getByRole('button', { name: 'Load older messages' });
    fireEvent.click(btn);
    expect(onLoadOlder).toHaveBeenCalled();
  });

  it('shows a loading label while a request is in flight', () => {
    renderList({ historySupported: true, historyLoading: true, onLoadOlder: vi.fn() });
    expect(screen.getByText('Loading older messages…')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Load older messages' })).toBeNull();
  });

  it('hides the affordance when exhausted or unsupported', () => {
    const { rerender } = renderList({ historySupported: true, historyExhausted: true, onLoadOlder: vi.fn() });
    expect(screen.queryByRole('button', { name: 'Load older messages' })).toBeNull();
    rerender(
      <MessageList messages={signal<ChatMessage[]>([])} members={[]} myNick="me" scrollRef={createRef()} channelName="#t"
        historySupported={false} onLoadOlder={vi.fn()} />,
    );
    expect(screen.queryByRole('button', { name: 'Load older messages' })).toBeNull();
  });

  it('shows "Beginning of history" in the ribbon when exhausted', () => {
    renderList({ historySupported: true, historyExhausted: true, onLoadOlder: vi.fn() });
    expect(screen.getByText('Beginning of history')).toBeInTheDocument();
  });

  it('shows a retryable error and retries on click', () => {
    const onLoadOlder = vi.fn();
    renderList({ historySupported: true, historyError: 'No response from server', onLoadOlder });
    const btn = screen.getByRole('button', { name: /No response from server — retry/ });
    fireEvent.click(btn);
    expect(onLoadOlder).toHaveBeenCalled();
  });

  it('fires load-older (debounced) only when scrolled to the very top', () => {
    vi.useFakeTimers();
    try {
      const onLoadOlder = vi.fn();
      const ref = createRef<HTMLDivElement>();
      render(
        <MessageList messages={signal<ChatMessage[]>([])} members={[]} myNick="me" scrollRef={ref} channelName="#t"
          historySupported onLoadOlder={onLoadOlder} />,
      );
      const el = ref.current!;
      // Near the top but not parked at it → ignored.
      Object.defineProperty(el, 'scrollTop', { value: 40, configurable: true });
      fireEvent.scroll(el);
      vi.advanceTimersByTime(300);
      expect(onLoadOlder).not.toHaveBeenCalled();
      // At the very top → fires once, after the debounce settles.
      Object.defineProperty(el, 'scrollTop', { value: 0, configurable: true });
      fireEvent.scroll(el);
      expect(onLoadOlder).not.toHaveBeenCalled(); // debounced, not yet
      vi.advanceTimersByTime(300);
      expect(onLoadOlder).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('debounces a burst of scroll events into a single pull', () => {
    vi.useFakeTimers();
    try {
      const onLoadOlder = vi.fn();
      const ref = createRef<HTMLDivElement>();
      render(
        <MessageList messages={signal<ChatMessage[]>([])} members={[]} myNick="me" scrollRef={ref} channelName="#t"
          historySupported onLoadOlder={onLoadOlder} />,
      );
      const el = ref.current!;
      Object.defineProperty(el, 'scrollTop', { value: 0, configurable: true });
      for (let i = 0; i < 5; i++) { fireEvent.scroll(el); vi.advanceTimersByTime(50); }
      vi.advanceTimersByTime(300);
      expect(onLoadOlder).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
