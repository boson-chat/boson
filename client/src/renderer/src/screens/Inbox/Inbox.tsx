import { Button, Modal } from '@boson/shared';
import { useState } from 'preact/hooks';
import { getMemoStore, type Memo } from '../../modules/memos';
import './Inbox.css';

interface InboxProps {
  open: boolean;
  memos: ReadonlyArray<Memo>;
  onClose: () => void;
  // Open the conversation an entry came from (switch server + open the DM /
  // focus the mention's channel). The host wires it to navigation.
  onOpen?: (memo: Memo) => void;
  // Fetch an unread memo's body (issues READ <n> on its server). Called
  // when the user opens a memo whose body hasn't been retrieved yet.
  onReadMemo?: (memo: Memo) => void;
}

// The Inbox is split into two tabs. "Messages" collects everything addressed
// directly to you (MemoServ memos + real-user DMs); "Mentions" collects
// channel messages that named your nick. Service notices (the rare 'service'
// kind) ride along in Messages.
type Tab = 'messages' | 'mentions';
const TAB_KINDS: Record<Tab, ReadonlyArray<Memo['kind']>> = {
  messages: ['memo', 'dm', 'service'],
  mentions: ['mention'],
};

// A LIST-sourced memo whose body we haven't fetched yet (deferred so the
// memo stays unread on the server until the user opens it).
function isUnfetchedMemo(m: Memo): boolean {
  return m.kind === 'memo' && m.memoIndex != null && !m.bodyFetched;
}

function kindLabel(kind: Memo['kind']): string {
  switch (kind) {
    case 'memo': return 'memo';
    case 'service': return 'service';
    case 'dm': return 'DM';
    case 'mention': return 'mention';
  }
}

// First letter of the sender, for the row avatar.
function initial(name: string): string {
  return (name.trim()[0] ?? '?').toUpperCase();
}

export function Inbox({ open, memos, onClose, onOpen, onReadMemo }: InboxProps) {
  const [tab, setTab] = useState<Tab>('messages');

  const inTab = (m: Memo, t: Tab) => TAB_KINDS[t].includes(m.kind);
  // Newest first — the canonical mailbox order.
  const sorted = [...memos].sort((a, b) => b.timestamp - a.timestamp);
  const items = sorted.filter((m) => inTab(m, tab));
  const unreadIn = (t: Tab) => memos.reduce((n, m) => n + (inTab(m, t) && !m.read ? 1 : 0), 0);

  return (
    <Modal open={open} onClose={onClose} title="Inbox">
      <div class="inbox-body">
        <div class="inbox-tabs" role="tablist">
          {(['messages', 'mentions'] as const).map((t) => {
            const unread = unreadIn(t);
            return (
              <button
                key={t}
                type="button"
                role="tab"
                aria-selected={tab === t}
                class={`inbox-tab ${tab === t ? 'inbox-tab-active' : ''}`}
                onClick={() => setTab(t)}
              >
                <span class="inbox-tab-icon" aria-hidden="true">{t === 'messages' ? '✉' : '@'}</span>
                {t === 'messages' ? 'Messages' : 'Mentions'}
                {unread > 0 && <span class="inbox-tab-badge">{unread}</span>}
              </button>
            );
          })}
          <span class="inbox-tabs-spacer" />
          {items.length > 0 && (
            <Button variant="ghost" size="sm" onClick={() => { getMemoStore().clear(TAB_KINDS[tab]); }}>
              Clear
            </Button>
          )}
        </div>

        {items.length === 0 ? (
          <div class="inbox-empty">
            <span class="inbox-empty-glyph" aria-hidden="true">{tab === 'messages' ? '✉' : '@'}</span>
            {tab === 'messages' ? (
              <>
                <p class="inbox-empty-title">No messages yet</p>
                <p class="inbox-empty-hint">
                  MemoServ memos and direct messages from people land here — one
                  place across every network. DMs also stay as normal chat
                  conversations.
                </p>
              </>
            ) : (
              <>
                <p class="inbox-empty-title">No mentions yet</p>
                <p class="inbox-empty-hint">
                  When someone says your nick in a channel, it shows up here so a
                  ping never slips past you. Click one to jump to the channel.
                </p>
              </>
            )}
          </div>
        ) : (
          <ul class="inbox-list">
            {items.map((m) => {
              const unfetched = isUnfetchedMemo(m);
              const title = unfetched
                ? `Read memo from ${m.sender}`
                : m.kind === 'dm'
                  ? `Open chat with ${m.sender}`
                  : m.kind === 'mention'
                    ? `Go to ${m.channel ?? m.serverName}`
                    : `Go to ${m.serverName || m.serverId}`;
              return (
                <li key={m.id} class={`inbox-row ${m.read ? '' : 'inbox-row-unread'}`}>
                  <button
                    type="button"
                    class="inbox-row-open"
                    onClick={() => (unfetched ? onReadMemo?.(m) : onOpen?.(m))}
                    title={title}
                  >
                    <span class={`inbox-avatar inbox-avatar-${m.kind}`} aria-hidden="true">
                      {initial(m.sender)}
                    </span>
                    <span class="inbox-row-main">
                      <span class="inbox-row-meta">
                        <span class="inbox-row-sender">{m.sender || 'unknown'}</span>
                        {m.kind === 'mention' && m.channel && (
                          <span class="inbox-row-channel">{m.channel}</span>
                        )}
                        <span class={`inbox-row-kind inbox-row-kind-${m.kind}`}>{kindLabel(m.kind)}</span>
                        <span class="inbox-row-server">{m.serverName || m.serverId || 'unknown'}</span>
                        <span class="inbox-row-time">
                          {m.kind === 'memo' && m.memoDate ? m.memoDate : formatTimestamp(m.timestamp)}
                        </span>
                      </span>
                      <span class="inbox-row-text">
                        {unfetched
                          ? <span class="inbox-row-placeholder">Click to read →</span>
                          : m.text}
                      </span>
                    </span>
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
              );
            })}
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
