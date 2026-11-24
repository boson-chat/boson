import { useEffect, useRef } from 'preact/hooks';
import { ChevronDown, ChevronUp, X } from 'lucide-preact';
import { Button, Input } from '@boson/shared';
import type { ChatMessage } from '../../modules/chat';
import { stripIrcFormatting } from './markdown';

// In-conversation search: the bar under the channel header (Ctrl/Cmd+F, or
// the header's search button). It searches the messages loaded in this
// conversation; where the server keeps history (CHATHISTORY) it offers to
// load older ones to search further.

const SEARCHABLE: ReadonlySet<ChatMessage['kind']> = new Set(['message', 'notice', 'action']);

// The ids of the messages whose text holds `query` (any case), oldest first.
export function findMatches(messages: readonly ChatMessage[], query: string): string[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  const out: string[] = [];
  for (const m of messages) {
    if (!SEARCHABLE.has(m.kind)) continue;
    if (stripIrcFormatting(m.text).toLowerCase().includes(needle)) out.push(m.id);
  }
  return out;
}

interface ChatSearchBarProps {
  query: string;
  onQuery: (q: string) => void;
  /** Matches, and the current one's position in them (0-based; -1: none). */
  count: number;
  index: number;
  /** Step to the previous (older, up) / next (newer, down) match. */
  onOlder: () => void;
  onNewer: () => void;
  onClose: () => void;
  /** The server keeps history: older messages can be loaded and searched. */
  history?: { loading: boolean; exhausted: boolean; onLoadOlder: () => void } | null;
  /** Bumped to focus (and select) the field again, e.g. a second Ctrl+F. */
  focusSeq: number;
  narrow?: boolean;
}

export function ChatSearchBar({ query, onQuery, count, index, onOlder, onNewer, onClose, history, focusSeq, narrow = false }: ChatSearchBarProps) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const input = wrapRef.current?.querySelector('input');
    if (!input) return;
    input.focus();
    input.select();
  }, [focusSeq]);
  const has = query.trim().length > 0;
  const status = !has ? '' : count === 0 ? 'No matches' : `${index + 1} of ${count}`;
  const size = narrow ? 'lg' : 'sm';
  return (
    <div class="chat-search" role="search" aria-label="Search this conversation">
      <div class="chat-search-row">
        <div class="chat-search-field" ref={wrapRef}>
          <Input
            inputSize="sm"
            type="search"
            placeholder="Search this conversation"
            aria-label="Search this conversation"
            value={query}
            onInput={(e) => onQuery((e.currentTarget as HTMLInputElement).value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose(); return; }
              if (e.key === 'Enter') {
                e.preventDefault();
                // Enter walks back through older matches; Shift+Enter forward.
                if (e.shiftKey) onNewer(); else onOlder();
              }
            }}
          />
        </div>
        <span class="chat-search-count" aria-live="polite">{status}</span>
        <Button variant="ghost" size={size} class="chat-search-nav" onClick={onOlder} disabled={count === 0}
          title="Older match (Enter)" aria-label="Older match" icon={<ChevronUp aria-hidden="true" />} />
        <Button variant="ghost" size={size} class="chat-search-nav" onClick={onNewer} disabled={count === 0}
          title="Newer match (Shift+Enter)" aria-label="Newer match" icon={<ChevronDown aria-hidden="true" />} />
        <Button variant="ghost" size={size} class="chat-search-close" onClick={onClose}
          title="Close search (Esc)" aria-label="Close search" icon={<X aria-hidden="true" />} />
      </div>
      {history && !history.exhausted && (
        <div class="chat-search-more">
          <span class="chat-search-more-text">Searching the messages loaded so far.</span>
          <Button variant="ghost" size="sm" class="chat-search-more-btn" onClick={history.onLoadOlder} disabled={history.loading}>
            {history.loading ? 'Loading older messages…' : 'Search older messages'}
          </Button>
        </div>
      )}
    </div>
  );
}
