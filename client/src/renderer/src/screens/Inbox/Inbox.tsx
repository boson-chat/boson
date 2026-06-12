import { Button, Modal } from '@boson/shared';
import { getMemoStore, type Memo } from '../../modules/memos';
import './Inbox.css';

interface InboxProps {
  open: boolean;
  memos: ReadonlyArray<Memo>;
  onClose: () => void;
  // Open the conversation an entry came from (switch server + open the DM).
  // Called with the clicked entry; the host wires it to navigation.
  onOpen?: (memo: Memo) => void;
  // Fetch an unread memo's body (issues READ <n> on its server). Called
  // when the user opens a memo whose body hasn't been retrieved yet.
  onReadMemo?: (memo: Memo) => void;
}

// A LIST-sourced memo whose body we haven't fetched yet (deferred so the
// memo stays unread on the server until the user opens it).
function isUnfetchedMemo(m: Memo): boolean {
  return m.kind === 'memo' && m.memoIndex != null && !m.bodyFetched;
}

// Cross-server Inbox. Aggregates everything addressed 1:1 to the user
// across every network — MemoServ memos, messages from service pseudo-
// users (NickServ/ChanServ/…, which are hidden from the chat stream),
// and direct messages from real users (which also stay as chat
// conversations). One chronological list, persisted via localStorage;
// this view is just the renderer.
//
// Each row is clickable (→ onOpen, jumps to that conversation) and has a
// dismiss (×) that removes just that entry.

// Short human label per entry kind.
function kindLabel(kind: Memo['kind']): string {
  switch (kind) {
    case 'memo': return 'memo';
    case 'service': return 'service';
    case 'dm': return 'DM';
  }
}

export function Inbox({ open, memos, onClose, onOpen, onReadMemo }: InboxProps) {
  // Newest first — the canonical mailbox order.
  const sorted = [...memos].sort((a, b) => b.timestamp - a.timestamp);
  return (
    <Modal open={open} onClose={onClose} title="Inbox">
      <div class="inbox-body">
        <div class="inbox-header">
          <span class="inbox-count">
            {memos.length === 0
              ? 'Nothing yet.'
              : `${memos.length} item${memos.length === 1 ? '' : 's'}`}
          </span>
          {memos.length > 0 && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => { getMemoStore().clear(); }}
            >
              Clear all
            </Button>
          )}
        </div>
        {memos.length === 0 ? (
          <div class="inbox-empty">
            <p>
              Everything sent directly to you collects here — <code>MemoServ</code>
              memos, messages from network services, and direct messages from
              other users.
            </p>
            <p class="inbox-empty-hint">
              Messages from services (NickServ, ChanServ, …) live only here, out
              of your chat view. DMs from people also appear as normal chat
              conversations.
            </p>
          </div>
        ) : (
          <ul class="inbox-list">
            {sorted.map((m) => (
              <li key={m.id} class={`inbox-row ${m.read ? '' : 'inbox-row-unread'}`}>
                <button
                  type="button"
                  class="inbox-row-open"
                  onClick={() => (isUnfetchedMemo(m) ? onReadMemo?.(m) : onOpen?.(m))}
                  title={
                    isUnfetchedMemo(m)
                      ? `Read memo from ${m.sender}`
                      : m.kind === 'dm'
                        ? `Open chat with ${m.sender}`
                        : `Go to ${m.serverName || m.serverId}`
                  }
                >
                  <div class="inbox-row-meta">
                    <span class="inbox-row-sender">{m.sender || 'unknown'}</span>
                    <span class={`inbox-row-kind inbox-row-kind-${m.kind}`}>{kindLabel(m.kind)}</span>
                    <span class="inbox-row-server">{m.serverName || m.serverId || 'unknown server'}</span>
                    <span class="inbox-row-time">
                      {m.kind === 'memo' && m.memoDate ? m.memoDate : formatTimestamp(m.timestamp)}
                    </span>
                  </div>
                  <div class="inbox-row-text">
                    {isUnfetchedMemo(m)
                      ? <span class="inbox-row-placeholder">Click to read</span>
                      : m.text}
                  </div>
                </button>
                <button
                  type="button"
                  class="inbox-row-dismiss"
                  aria-label="Dismiss"
                  title="Dismiss"
                  onClick={(e) => { e.stopPropagation(); getMemoStore().remove(m.id); }}
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Modal>
  );
}

// Compact human time — "12:34" for today, "Mon 14:22" for this week,
// "2026-05-28" for older. Avoids dragging in a date-fmt lib for one
// view; the inbox is the only place we format memo timestamps.
function formatTimestamp(ts: number): string {
  const d = new Date(ts);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) {
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }
  const diffDays = (now.getTime() - ts) / (1000 * 60 * 60 * 24);
  if (diffDays < 7) {
    return d.toLocaleDateString([], { weekday: 'short' }) + ' '
      + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }
  return d.toLocaleDateString([], { year: 'numeric', month: '2-digit', day: '2-digit' });
}
