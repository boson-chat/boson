import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { Signal } from '@preact/signals';
import { ArrowLeft, Search, X } from 'lucide-preact';
import { Button, EmptyState, Input, ListRow, Menu, MenuItem } from '@boson/shared';
import type { ChatMember, ChatMessage } from '../../modules/chat';
import { Avatar } from '../../shared/Avatar/Avatar';
import {
  authorsOf, contextOf, dayLabel, groupByDay, highlightParts, isActive, mergeLines, plainText, search, shortDate, timeLabel,
  type SearchFilters,
} from '../../modules/search/search-match';
import { BATCH_SIZE, type HistorySource, type PagerState } from '../../modules/search/history-pager';
import type { ConversationSearch } from '../../modules/search/search-session';
import './SearchPage.css';

// The full-page conversation search (the header's Search, Ctrl/Cmd+F): in
// place of the conversation — full screen on phones, the chat column on
// wider screens. It searches what's loaded first; "Older results" fetches
// the server's history (CHATHISTORY) a batch at a time. The query never
// leaves the device.
//
// Opening a result goes to it in the conversation (onOpenResult). On a wide
// window (the Context panel) a click picks a result and shows the lines
// around it; arrows move the pick and Enter opens it.

const DEBOUNCE_MS = 200;

export interface SearchPageProps {
  /** The conversation's name (#chan, or a nick). */
  conversation: string;
  /** Its search (query, filters, fetched history), kept for the session. */
  session: ConversationSearch;
  /** The conversation's loaded messages. */
  messages: Signal<ChatMessage[]>;
  members: readonly ChatMember[];
  /** The server's history (null: none to fetch). */
  history: HistorySource | null;
  avatarFor?: (nick: string) => string | undefined;
  narrow: boolean;
  /** Wide enough for the Context panel beside the results. */
  wide: boolean;
  /** Bumped to focus (and select) the search box again. */
  focusSeq: number;
  /** Back to results: focus the picked result, not the box (no keyboard popping up on a phone). */
  restoring?: boolean;
  onClose: () => void;
  /** Go to a result in the conversation. */
  onOpenResult: (m: ChatMessage) => Promise<void>;
}

// A result's row in the list, by message id.
function resultRow(list: HTMLElement | null, id: string): HTMLElement | null {
  return Array.from(list?.querySelectorAll<HTMLElement>('[data-result-id]') ?? []).find((el) => el.dataset['resultId'] === id) ?? null;
}

function usePager(session: ConversationSearch): PagerState {
  const [state, setState] = useState(() => session.pager.getState());
  useEffect(() => {
    setState(session.pager.getState());
    return session.pager.subscribe(setState);
  }, [session]);
  return state;
}

function Highlighted({ text, needle, lead }: { text: string; needle: string; lead?: number }) {
  return (
    <>
      {highlightParts(text, needle, lead).map((p, i) => (p.match
        ? <mark key={i} class="search-hit">{p.text}</mark>
        : <span key={i}>{p.text}</span>))}
    </>
  );
}

export function SearchPage({
  conversation, session, messages, members, history, avatarFor, narrow, wide, focusSeq, restoring = false, onClose, onOpenResult,
}: SearchPageProps) {
  const isChannel = /^[#&]/.test(conversation);
  const where = isChannel ? `in ${conversation}` : `with @${conversation}`;
  const pager = usePager(session);
  const status = history ? session.pager.statusWith(history) : 'unsupported';

  // The box follows typing; the search, the box 200ms after the last key.
  const [input, setInput] = useState(session.ui.query);
  const [query, setQuery] = useState(session.ui.query);
  const [from, setFrom] = useState<string | null>(session.ui.from);
  const [hasLink, setHasLink] = useState(session.ui.hasLink);
  const [selectedId, setSelectedId] = useState<string | null>(session.ui.selectedId);
  useEffect(() => {
    if (input === query) return undefined;
    const t = setTimeout(() => setQuery(input), DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [input]);
  useEffect(() => { session.save({ query, from, hasLink, selectedId }); }, [session, query, from, hasLink, selectedId]);

  const filters: SearchFilters = { text: query, from, hasLink };
  const loaded = messages.value;
  const lines = useMemo(() => mergeLines(loaded, pager.lines), [loaded, pager.lines]);
  const results = useMemo(() => search(lines, filters), [lines, query, from, hasLink]);
  const groups = useMemo(() => groupByDay(results), [results]);
  const active = isActive(filters);
  const searched = useMemo(() => lines.filter((m) => m.kind === 'message' || m.kind === 'action'), [lines]);
  const oldest = searched[0];

  // From…: the channel's members and whoever said something matching.
  const nicks = useMemo(() => {
    const byKey = new Map<string, string>();
    for (const n of [...members.map((m) => m.nick), ...authorsOf(search(lines, { ...filters, from: null }))]) {
      if (n && !byKey.has(n.toLowerCase())) byKey.set(n.toLowerCase(), n);
    }
    return [...byKey.values()].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
  }, [members, lines, query, hasLink]);
  const [fromMenu, setFromMenu] = useState<{ top: number; left: number } | null>(null);
  const fromBtn = useRef<HTMLButtonElement>(null);
  const toggleFromMenu = (): void => {
    if (fromMenu) { setFromMenu(null); return; }
    const r = fromBtn.current?.getBoundingClientRect();
    if (!r) return;
    const width = Math.min(240, document.documentElement.clientWidth - 16);
    setFromMenu({ top: r.bottom + 4, left: Math.max(8, Math.min(r.left, document.documentElement.clientWidth - width - 8)) });
  };

  // The picked result (the Context panel). On a wide window one is always
  // picked while there are results: the newest, until the user moves.
  const selected = (selectedId ? results.find((m) => m.id === selectedId) : undefined) ?? (wide ? results[0] : undefined);
  const flat = results;

  // Focus the box on open, and again (selecting it) on a second Ctrl+F.
  const inputRef = useRef<HTMLDivElement>(null);
  const firstFocus = useRef(true);
  useLayoutEffect(() => {
    const restore = firstFocus.current && restoring;
    firstFocus.current = false;
    if (restore) {
      const id = session.ui.selectedId;
      const row = id ? resultRow(listRef.current, id)?.querySelector('button') : null;
      if (row) { row.focus({ preventScroll: true }); return; }
    }
    const el = inputRef.current?.querySelector('input');
    if (!el) return;
    el.focus();
    el.select();
  }, [focusSeq]);

  // Back to results: the list where it was.
  const listRef = useRef<HTMLDivElement>(null);
  const restored = useRef(false);
  useLayoutEffect(() => {
    if (restored.current) return;
    restored.current = true;
    if (listRef.current && session.ui.scrollTop > 0) listRef.current.scrollTop = session.ui.scrollTop;
  });

  const [opening, setOpening] = useState(false);
  const [openError, setOpenError] = useState<string | null>(null);
  const open = (m: ChatMessage): void => {
    if (opening) return;
    setSelectedId(m.id);
    session.save({ selectedId: m.id, scrollTop: listRef.current?.scrollTop ?? session.ui.scrollTop });
    setOpening(true);
    setOpenError(null);
    onOpenResult(m).catch((e: unknown) => {
      setOpenError(e instanceof Error ? e.message : String(e));
    }).finally(() => setOpening(false));
  };
  const pick = (m: ChatMessage): void => {
    if (wide) setSelectedId(m.id);
    else open(m);
  };

  const move = (dir: 1 | -1, focusRow: boolean): void => {
    if (flat.length === 0) return;
    const at = selected ? flat.indexOf(selected) : -1;
    const next = flat[Math.max(0, Math.min(flat.length - 1, at < 0 ? 0 : at + dir))]!;
    setSelectedId(next.id);
    const row = resultRow(listRef.current, next.id);
    row?.scrollIntoView?.({ block: 'nearest' });
    if (focusRow) row?.querySelector<HTMLButtonElement>('button')?.focus();
  };
  // Esc closes it on desktop, wherever the focus is (not while the From
  // menu or a dialog is open: Esc closes that).
  const escRef = useRef({ menu: false, narrow, onClose });
  escRef.current = { menu: !!fromMenu, narrow, onClose };
  // (Layout effects, here and for the focus: at once, not a frame later.)
  useLayoutEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const s = escRef.current;
      if (e.key !== 'Escape' || e.defaultPrevented || s.narrow || s.menu) return;
      if (document.querySelector('.bds-modal-backdrop, .bds-sheet-backdrop')) return;
      e.preventDefault();
      s.onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  const onKeyDown = (e: KeyboardEvent): void => {
    if (!wide) return;
    const inRow = e.target instanceof HTMLElement && !!e.target.closest('[data-result-id]');
    const inBox = e.target instanceof HTMLInputElement;
    if (!inRow && !inBox) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      move(e.key === 'ArrowDown' ? 1 : -1, inRow);
    } else if (e.key === 'Enter' && selected) {
      e.preventDefault();
      open(selected);
    }
  };

  const fetchOlder = (): void => {
    if (!history) return;
    const first = loaded[0];
    void session.pager.loadOlder(history, first ? first.serverTime ?? first.timestamp : null);
  };

  const count = !active ? '' : results.length === 1 ? '1 result' : `${results.length} results`;
  const size = narrow ? 'lg' : 'sm';
  const rowSize = narrow ? 'lg' : 'md';
  const ctx = selected ? contextOf(lines, selected) : null;

  return (
    <section class={`search-page${narrow ? ' search-page-phone' : ''}${wide ? ' search-page-wide' : ''}`}
      aria-label={`Search ${where}`} onKeyDown={onKeyDown}>
      <div class="search-main">
        <header class="search-head">
          <div class="search-title-row">
            <Button variant="ghost" size={narrow ? 'lg' : 'md'} class="search-back" onClick={onClose}
              aria-label={`Back to ${isChannel ? conversation : `@${conversation}`}`} icon={<ArrowLeft aria-hidden="true" />} />
            <div class="search-titles">
              <h1 class="search-title">Search</h1>
              <span class="search-where">{where}</span>
            </div>
            {!narrow && <span class="search-esc">Esc to close</span>}
          </div>
          <div class="search-controls" role="search">
            <div class="search-field" ref={inputRef}>
              <Search class="search-field-icon" aria-hidden="true" />
              <Input
                type="search"
                inputSize="md"
                placeholder="Search messages"
                aria-label="Search messages"
                value={input}
                onInput={(e) => setInput((e.currentTarget as HTMLInputElement).value)}
                enterKeyHint="search"
                autoComplete="off"
                spellcheck={false}
              />
              {input && (
                <Button variant="ghost" size="sm" class="search-clear" aria-label="Clear search"
                  onClick={() => {
                    setInput(''); setQuery('');
                    inputRef.current?.querySelector('input')?.focus();
                  }}
                  icon={<X aria-hidden="true" />} />
              )}
            </div>
            <div class="search-chips" role="group" aria-label="Filters">
              <Button variant="secondary" size={size} class="search-chip" pressed={from === null}
                onClick={() => setFrom(null)}>Anyone</Button>
              <Button variant="secondary" size={size} class="search-chip" pressed={from !== null}
                buttonRef={fromBtn}
                aria-haspopup="menu" aria-expanded={!!fromMenu}
                onMouseDown={(e: MouseEvent) => e.stopPropagation()}
                onClick={toggleFromMenu}>
                {from === null ? 'From…' : `From ${from}`}
              </Button>
              <Button variant="secondary" size={size} class="search-chip" pressed={hasLink}
                onClick={() => setHasLink((v) => !v)}>Has link</Button>
            </div>
          </div>
        </header>
        {fromMenu && (
          <Menu label="From" class="search-from-menu" onClose={() => setFromMenu(null)}
            style={{ position: 'fixed', top: `${fromMenu.top}px`, left: `${fromMenu.left}px` }}>
            <MenuItem size={narrow ? 'lg' : 'md'} checked={from === null} onClick={() => { setFrom(null); setFromMenu(null); }}>Anyone</MenuItem>
            {nicks.map((n) => (
              <MenuItem key={n} size={narrow ? 'lg' : 'md'} checked={from?.toLowerCase() === n.toLowerCase()}
                onClick={() => { setFrom(n); setFromMenu(null); }}>{n}</MenuItem>
            ))}
          </Menu>
        )}

        <div class="search-status">
          <span class="search-count" role="status" aria-live="polite">{count}</span>
          {oldest && (
            <span class="search-depth">
              Searched back to {shortDate(oldest.timestamp)}{!narrow ? ` · ${searched.length.toLocaleString('en-US')} messages` : ''}
            </span>
          )}
        </div>

        <div class="search-results" ref={listRef}
          onScroll={(e) => session.save({ scrollTop: (e.currentTarget as HTMLDivElement).scrollTop })}>
          {!active ? (
            <EmptyState class="search-empty" icon={<Search />}>
              Search the messages {where}. Older ones come from the server's history as you ask for them.
            </EmptyState>
          ) : results.length === 0 ? (
            <EmptyState class="search-empty">No messages match{status === 'idle' || status === 'error' ? ' in what has been searched so far' : ''}.</EmptyState>
          ) : groups.map((g) => (
            <section key={g.key} class="search-day-group" aria-labelledby={`search-day-${g.key}`}>
              <h2 class="search-day" id={`search-day-${g.key}`}>{g.label}</h2>
              <ul class="search-list" aria-labelledby={`search-day-${g.key}`}>
                {g.items.map((m) => {
                  const isSel = wide && selected === m;
                  return (
                    <ListRow
                      key={m.id}
                      as="li"
                      size={rowSize}
                      class="search-result"
                      rowProps={{ 'data-result-id': m.id } as Record<string, string>}
                      selected={isSel}
                      leading={<Avatar nick={m.from} url={avatarFor?.(m.from)} size={narrow ? 32 : 28} />}
                      title={m.from}
                      aside={timeLabel(m.timestamp)}
                      subtitle={<Highlighted text={m.kind === 'action' ? `${m.from} ${plainText(m)}` : plainText(m)} needle={query} />}
                      subtitleLines={2}
                      mainProps={{ 'aria-current': isSel ? 'true' : undefined }}
                      onClick={() => pick(m)}
                    />
                  );
                })}
              </ul>
            </section>
          ))}

          {active && (
            <div class="search-more">
              {status === 'unsupported' ? (
                <p class="search-more-note">This server doesn't keep history: only the messages loaded here were searched.</p>
              ) : status === 'end' ? (
                <p class="search-more-note">That's everything the server keeps for this {isChannel ? 'channel' : 'conversation'}.</p>
              ) : (
                <>
                  {status === 'error' && (
                    <p class="search-more-note search-more-error" role="alert">Couldn't fetch older messages: {pager.error}</p>
                  )}
                  <Button variant="secondary" size={narrow ? 'lg' : 'md'} class="search-older"
                    loading={status === 'loading'} disabled={status === 'loading'} onClick={fetchOlder}>
                    {status === 'error' ? 'Try again' : status === 'loading' ? 'Fetching older messages…' : 'Older results'}
                  </Button>
                  <p class="search-more-hint">Fetches the next {BATCH_SIZE} messages from the server</p>
                </>
              )}
            </div>
          )}
        </div>
        {openError && <p class="search-open-error" role="alert">Couldn't open that message: {openError}</p>}
      </div>

      {wide && (
        <aside class="search-context" aria-label="Context">
          <header class="search-context-head">
            <span class="search-context-label">Context</span>
            {selected && (
              <span class="search-context-when">{dayLabel(selected.timestamp)} · {timeLabel(selected.timestamp)}</span>
            )}
            {selected && (
              <Button variant="primary" size="sm" class="search-context-open" loading={opening}
                onClick={() => open(selected)}>Open in conversation</Button>
            )}
          </header>
          {selected && ctx ? (
            <ol class="search-context-lines">
              {ctx.before.map((m) => <ContextLine key={m.id} m={m} needle="" />)}
              <ContextLine m={selected} needle={query} current />
              {ctx.after.map((m) => <ContextLine key={m.id} m={m} needle="" />)}
            </ol>
          ) : (
            <EmptyState class="search-empty">Pick a result to see the messages around it.</EmptyState>
          )}
        </aside>
      )}
    </section>
  );
}

function ContextLine({ m, needle, current = false }: { m: ChatMessage; needle: string; current?: boolean }) {
  return (
    <li class={`search-context-line${current ? ' search-context-current' : ''}`} aria-current={current ? 'true' : undefined}>
      <span class="search-context-nick">{m.from}</span>
      <span class="search-context-text">
        {m.kind === 'action' && <span>{m.from} </span>}
        <Highlighted text={plainText(m)} needle={needle} lead={-1} />
      </span>
    </li>
  );
}
