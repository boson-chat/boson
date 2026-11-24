import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/preact';
import { signal } from '@preact/signals';
import type { ChatMember, ChatMessage } from '../../modules/chat';
import { SearchPage, type SearchPageProps } from './SearchPage';
import { ConversationSearch } from '../../modules/search/search-session';
import type { HistorySource } from '../../modules/search/history-pager';

// The full-page conversation search: the box (debounced), the filters, the
// results (newest first, by day, the match marked), Older results paging
// back through the server's history, opening a result, the Context panel on
// wide windows, and coming back to the same page.

const NOW = Date.now();
let n = 0;
const msg = (from: string, text: string, minsAgo: number, extra: Partial<ChatMessage> = {}): ChatMessage =>
  ({ id: `m${++n}`, kind: 'message', from, text, timestamp: NOW - minsAgo * 60_000, msgid: `id${n}`, ...extra });

const members: ChatMember[] = [{ nick: 'kestrel', prefix: '@' }, { nick: 'me', prefix: '' }, { nick: 'zed', prefix: '' }];

function history(pages: ChatMessage[][], opts: { fail?: boolean } = {}) {
  const calls: Array<{ before: number; limit: number }> = [];
  let resolveNext: (() => void) | null = null;
  const gate = { hold: false };
  const src: HistorySource = {
    supported: () => true,
    chunkLimit: () => 500,
    fetchBefore: async (before, limit) => {
      calls.push({ before, limit });
      if (gate.hold) await new Promise<void>((r) => { resolveNext = r; });
      if (opts.fail) throw new Error('No response from server');
      return pages.shift() ?? [];
    },
  };
  return { src, calls, gate, release: () => resolveNext?.() };
}

function setup(over: Partial<SearchPageProps> = {}) {
  const loaded = signal<ChatMessage[]>([
    msg('mox', 'switched the resolver, DNS over TLS is on now', 60 * 26),
    msg('server', '', 60 * 25, { kind: 'join' }),
    msg('kestrel', 'the dns record still points at the old box', 30),
    msg('mox', 'see https://status.example.test', 20),
    msg('VW', 'I have a script that changes my local DNS', 5, { kind: 'action' }),
  ]);
  const props: SearchPageProps = {
    conversation: '#infra',
    session: new ConversationSearch(),
    messages: loaded,
    members,
    history: null,
    narrow: false,
    wide: false,
    focusSeq: 1,
    onClose: vi.fn(),
    onOpenResult: vi.fn(async () => {}),
    ...over,
  };
  const loadedSig = over.messages ?? loaded;
  const r = render(<SearchPage {...props} />);
  const box = screen.getByRole('searchbox', { name: 'Search messages' });
  const type = (text: string) => {
    fireEvent.input(box, { target: { value: text } });
    act(() => { vi.advanceTimersByTime(200); });
  };
  return { ...r, props, box, type, loaded: loadedSig };
}

// Let the pager's requests (a few awaits deep) and their renders settle.
const settle = async () => { for (let i = 0; i < 6; i++) await act(async () => { await Promise.resolve(); }); };

const resultTexts = () => screen.queryAllByRole('listitem')
  .filter((li) => li.classList.contains('search-result'))
  .map((li) => li.querySelector('.bds-row-sub')!.textContent);

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe('SearchPage', () => {
  it('a labelled, focused box; "in #channel" (or "with @nick")', () => {
    setup();
    expect(screen.getByRole('searchbox', { name: 'Search messages' })).toHaveFocus();
    expect(screen.getByRole('heading', { name: 'Search' })).toBeInTheDocument();
    expect(screen.getByText('in #infra')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Back to #infra' })).toBeInTheDocument();
  });

  it('a DM says who with', () => {
    setup({ conversation: 'mox' });
    expect(screen.getByText('with @mox')).toBeInTheDocument();
  });

  it('searches 200ms after the last key, any case, what people said; newest first under their day', () => {
    setup();
    const box = screen.getByRole('searchbox', { name: 'Search messages' });
    fireEvent.input(box, { target: { value: 'dns' } });
    expect(resultTexts()).toEqual([]);
    act(() => { vi.advanceTimersByTime(199); });
    expect(resultTexts()).toEqual([]);
    act(() => { vi.advanceTimersByTime(1); });
    expect(resultTexts()).toEqual([
      'VW I have a script that changes my local DNS',
      'the dns record still points at the old box',
      'switched the resolver, DNS over TLS is on now',
    ]);
    expect(screen.getByRole('heading', { name: 'Today' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Yesterday' })).toBeInTheDocument();
    // Each match marked.
    expect([...document.querySelectorAll('mark.search-hit')].map((m) => m.textContent)).toEqual(['DNS', 'dns', 'DNS']);
  });

  it('says how many, politely', () => {
    const { type } = setup();
    type('dns');
    const status = screen.getByRole('status');
    expect(status).toHaveAttribute('aria-live', 'polite');
    expect(status).toHaveTextContent('3 results');
    type('old box');
    expect(status).toHaveTextContent('1 result');
    expect(screen.getByText(/Searched back to/)).toBeInTheDocument();
  });

  it('shows text as text: markup in a message is not rendered', () => {
    const { type, loaded } = setup();
    loaded.value = [...loaded.value, msg('evil', '<img src=x onerror="alert(1)"> dns', 1)];
    type('dns');
    expect(document.querySelector('.search-page img')).toBeNull();
    expect(resultTexts()[0]).toBe('<img src=x onerror="alert(1)"> dns');
  });

  it('Has link, and From… (the channel\'s members and who said something)', () => {
    const { type } = setup();
    type('s');
    fireEvent.click(screen.getByRole('button', { name: 'Has link' }));
    expect(screen.getByRole('button', { name: 'Has link' })).toHaveAttribute('aria-pressed', 'true');
    expect(resultTexts()).toEqual(['see https://status.example.test']);
    fireEvent.click(screen.getByRole('button', { name: 'Has link' }));

    expect(screen.getByRole('button', { name: 'Anyone' })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(screen.getByRole('button', { name: 'From…' }));
    const menu = screen.getByRole('menu', { name: 'From' });
    const names = within(menu).getAllByRole('menuitemradio').map((b) => b.querySelector('.bds-menu-text')!.textContent);
    expect(names).toEqual(['Anyone', 'kestrel', 'me', 'mox', 'VW', 'zed']);
    fireEvent.click(within(menu).getByRole('menuitemradio', { name: 'mox' }));
    expect(screen.queryByRole('menu')).toBeNull();
    expect(screen.getByRole('button', { name: 'From mox' })).toHaveAttribute('aria-pressed', 'true');
    expect(resultTexts()).toEqual(['see https://status.example.test', 'switched the resolver, DNS over TLS is on now']);
    fireEvent.click(screen.getByRole('button', { name: 'Anyone' }));
    expect(resultTexts()).toHaveLength(4);
    // No native select anywhere.
    expect(document.querySelector('select')).toBeNull();
  });

  it('Older results: fetches older than the oldest loaded line, appends the matches, then says when it has everything', async () => {
    const h = history([[msg('kestrel', 'ancient dns talk', 60 * 24 * 30), msg('mox', 'nothing here', 60 * 24 * 29)], []]);
    const { type, loaded } = setup({ history: h.src });
    type('dns');
    expect(resultTexts()).toHaveLength(3);
    expect(screen.getByText('Fetches the next 500 messages from the server')).toBeInTheDocument();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Older results' })); });
    await settle();
    // Older than the oldest loaded line; then on from the oldest it got,
    // which the server answers with nothing: the end.
    expect(h.calls[0]).toEqual({ before: loaded.value[0]!.timestamp, limit: 500 });
    expect(h.calls[1]!.before).toBe(NOW - 60 * 24 * 30 * 60_000);
    expect(resultTexts()).toHaveLength(4);
    expect(resultTexts().at(-1)).toBe('ancient dns talk');
    expect(screen.getByText("That's everything the server keeps for this channel.")).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Older results' })).toBeNull();
  });

  it('after a full batch there may be more: Older results stays', async () => {
    const page = Array.from({ length: 500 }, (_, i) => msg('zed', `filler ${i}`, 60 * 24 * 40 - i));
    const h = history([page]);
    const { type } = setup({ history: h.src });
    type('filler 499');
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Older results' })); });
    expect(h.calls).toHaveLength(1);
    expect(resultTexts()).toEqual(['filler 499']);
    expect(screen.getByRole('button', { name: 'Older results' })).toBeEnabled();
  });

  it('the button is busy and disabled while a fetch is in flight', async () => {
    const h = history([[msg('kestrel', 'dns', 9999)]]);
    h.gate.hold = true;
    const { type } = setup({ history: h.src });
    type('dns');
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Older results' })); });
    const busy = screen.getByRole('button', { name: /Fetching older messages/ });
    expect(busy).toBeDisabled();
    expect(busy).toHaveAttribute('aria-busy', 'true');
    fireEvent.click(busy);
    expect(h.calls).toHaveLength(1);
    h.gate.hold = false;
    await act(async () => { h.release(); });
    await settle();
    expect(screen.queryByRole('button', { name: /Fetching/ })).toBeNull();
  });

  it('an error says so, and Try again', async () => {
    const h = history([], { fail: true });
    const { type } = setup({ history: h.src });
    type('dns');
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Older results' })); });
    expect(screen.getByRole('alert')).toHaveTextContent("Couldn't fetch older messages: No response from server");
    expect(screen.getByRole('button', { name: 'Try again' })).toBeEnabled();
  });

  it('without CHATHISTORY: only what is loaded, and it says so', () => {
    const { type } = setup({ history: null });
    type('dns');
    expect(screen.getByText(/This server doesn't keep history: only the messages loaded here were searched/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Older results' })).toBeNull();
  });

  it('phones: a tap opens the result; Escape is not a close there', () => {
    const { type, props } = setup({ narrow: true });
    type('old box');
    fireEvent.click(screen.getByRole('button', { name: /the dns record still points/ }));
    expect(props.onOpenResult).toHaveBeenCalledWith(expect.objectContaining({ text: 'the dns record still points at the old box' }));
    fireEvent.keyDown(screen.getByRole('searchbox'), { key: 'Escape' });
    expect(props.onClose).not.toHaveBeenCalled();
  });

  it('desktop: Escape closes; the back arrow too', () => {
    const { props, box } = setup();
    fireEvent.keyDown(box, { key: 'Escape' });
    expect(props.onClose).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Back to #infra' }));
    expect(props.onClose).toHaveBeenCalledTimes(2);
  });

  it('wide: a click picks a result and shows its context; arrows move the pick, Enter opens it', async () => {
    const { type, props, box } = setup({ wide: true });
    type('dns');
    const ctx = screen.getByRole('complementary', { name: 'Context' });
    // The newest is picked to start with.
    expect(within(ctx).getByText('I have a script that changes my local', { exact: false })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /the dns record still points/ }));
    expect(props.onOpenResult).not.toHaveBeenCalled();
    const lines = within(ctx).getAllByRole('listitem');
    // Up to 3 before and after (people's lines only), the match marked.
    expect(lines.map((l) => l.querySelector('.search-context-text')!.textContent)).toEqual([
      'switched the resolver, DNS over TLS is on now',
      'the dns record still points at the old box',
      'see https://status.example.test',
      'VW I have a script that changes my local DNS',
    ]);
    expect(lines[1]).toHaveAttribute('aria-current', 'true');
    expect(lines[1]!.querySelector('mark')).toHaveTextContent('dns');
    // ArrowDown from the box: the next (older) one; Enter opens it.
    fireEvent.keyDown(box, { key: 'ArrowDown' });
    expect(screen.getByRole('button', { name: /switched the resolver/ })).toHaveAttribute('aria-current', 'true');
    await act(async () => { fireEvent.keyDown(box, { key: 'Enter' }); });
    await settle();
    expect(props.onOpenResult).toHaveBeenCalledWith(expect.objectContaining({ text: 'switched the resolver, DNS over TLS is on now' }));
    fireEvent.click(within(ctx).getByRole('button', { name: 'Open in conversation' }));
    expect(props.onOpenResult).toHaveBeenCalledTimes(2);
  });

  it('back to results: the same query, filters, results, pick and scroll', () => {
    const session = new ConversationSearch();
    const first = setup({ session, narrow: true });
    first.type('dns');
    fireEvent.click(screen.getByRole('button', { name: 'Has link' }));
    fireEvent.click(screen.getByRole('button', { name: 'Has link' }));
    const list = document.querySelector('.search-results') as HTMLElement;
    list.scrollTop = 120;
    fireEvent.scroll(list);
    fireEvent.click(screen.getByRole('button', { name: /the dns record still points/ }));
    first.unmount();

    setup({ session, narrow: true, restoring: true, messages: first.loaded });
    expect(screen.getByRole('searchbox')).toHaveValue('dns');
    expect(resultTexts()).toHaveLength(3);
    expect((document.querySelector('.search-results') as HTMLElement).scrollTop).toBe(120);
    // The opened result has the focus (not the box: no keyboard on a phone).
    expect(screen.getByRole('button', { name: /the dns record still points/ })).toHaveFocus();
  });

  it('opening a result that fails says why', async () => {
    const { type } = setup({ narrow: true, onOpenResult: vi.fn(async () => { throw new Error('it is no longer available'); }) });
    type('old box');
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /the dns record still points/ })); });
    expect(screen.getByRole('alert')).toHaveTextContent("Couldn't open that message: it is no longer available");
  });
});
