import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/preact';
import { createRef } from 'preact';
import { signal } from '@preact/signals';
import type { ChatMessage } from '../../modules/chat';
import { LOAD_OLDER_MARGIN_PX, MessageList } from './message-render';

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

  it('fires after a bounce past the top (iOS rubber-band: negative scrollTop)', () => {
    vi.useFakeTimers();
    try {
      const onLoadOlder = vi.fn();
      const ref = createRef<HTMLDivElement>();
      render(
        <MessageList messages={signal<ChatMessage[]>([])} members={[]} myNick="me" scrollRef={ref} channelName="#t"
          historySupported onLoadOlder={onLoadOlder} />,
      );
      const el = ref.current!;
      for (const top of [120, 30, -40, -18]) {
        Object.defineProperty(el, 'scrollTop', { value: top, configurable: true });
        fireEvent.scroll(el);
        vi.advanceTimersByTime(16);
      }
      vi.advanceTimersByTime(300);
      expect(onLoadOlder).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

// The ribbon coming into view triggers a load too (an IntersectionObserver
// on the scroller): no exact scrollTop, no scroll-event timing.
describe('MessageList — load older when the ribbon comes into view', () => {
  type Entry = { isIntersecting: boolean; target: Element };
  let observers: Array<{ cb: (e: Entry[]) => void; opts: IntersectionObserverInit; targets: Element[] }> = [];
  const Original = globalThis.IntersectionObserver;
  beforeEach(() => {
    observers = [];
    class FakeIO {
      private readonly o: (typeof observers)[number];
      constructor(cb: (e: Entry[]) => void, opts: IntersectionObserverInit = {}) {
        this.o = { cb, opts, targets: [] };
        observers.push(this.o);
      }
      observe(t: Element) { this.o.targets.push(t); }
      unobserve() {}
      disconnect() { this.o.targets = []; }
      takeRecords() { return []; }
    }
    (globalThis as { IntersectionObserver: unknown }).IntersectionObserver = FakeIO;
  });
  afterEach(() => {
    (globalThis as { IntersectionObserver: unknown }).IntersectionObserver = Original;
  });
  const ribbonSeen = (on: boolean): void => {
    for (const o of observers) for (const t of o.targets) o.cb([{ isIntersecting: on, target: t }]);
  };
  const setup = (over: Partial<Parameters<typeof MessageList>[0]> = {}) => {
    const onLoadOlder = vi.fn();
    const ref = createRef<HTMLDivElement>();
    const props = {
      messages: signal<ChatMessage[]>([]), members: [], myNick: 'me', scrollRef: ref, channelName: '#t',
      historySupported: true, onLoadOlder, ...over,
    };
    const r = render(<MessageList {...props} />);
    return { onLoadOlder, el: ref.current!, props, rerender: r.rerender };
  };
  const userScroll = (el: HTMLElement, top: number): void => {
    Object.defineProperty(el, 'scrollTop', { value: top, configurable: true });
    fireEvent.scroll(el);
  };

  it('watches the ribbon, from the scroller, a margin early', () => {
    const { el } = setup();
    expect(observers).toHaveLength(1);
    expect(observers[0]!.opts.root).toBe(el);
    expect(observers[0]!.opts.rootMargin).toBe(`${LOAD_OLDER_MARGIN_PX}px 0px 0px 0px`);
    expect(observers[0]!.targets[0]).toBe(el.querySelector('.chat-load-older'));
  });

  it('loads when the ribbon comes into view once the user has scrolled', () => {
    const { onLoadOlder, el } = setup();
    // In view without any scrolling (a short conversation): left to the button.
    ribbonSeen(true);
    expect(onLoadOlder).not.toHaveBeenCalled();
    ribbonSeen(false);
    userScroll(el, 300);
    ribbonSeen(true);
    expect(onLoadOlder).toHaveBeenCalledTimes(1);
  });

  it('a touch drag on the list counts as the user scrolling (even with no scroll event)', () => {
    const { onLoadOlder, el } = setup();
    fireEvent.touchMove(el);
    ribbonSeen(true);
    expect(onLoadOlder).toHaveBeenCalledTimes(1);
  });

  it('not while a request is in flight, the history is done, or the last one failed', () => {
    for (const over of [{ historyLoading: true }, { historyExhausted: true }, { historyError: 'nope' }]) {
      observers = [];
      const { onLoadOlder, el } = setup(over);
      userScroll(el, 300);
      ribbonSeen(true);
      expect(onLoadOlder).not.toHaveBeenCalled();
    }
  });

  it('a new conversation starts over: no pull until it is scrolled', () => {
    const { onLoadOlder, el, props, rerender } = setup();
    userScroll(el, 300);
    rerender(<MessageList {...props} channelName="#other" />);
    ribbonSeen(true);
    expect(onLoadOlder).not.toHaveBeenCalled();
  });
});
