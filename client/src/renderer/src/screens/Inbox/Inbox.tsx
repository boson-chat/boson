import { Button, Modal } from '@boson/shared';
import { getMemoStore, type Memo } from '../../modules/memos';
import './Inbox.css';

interface InboxProps {
  open: boolean;
  memos: ReadonlyArray<Memo>;
  onClose: () => void;
}

// Cross-server Inbox. Aggregates every MemoServ NOTICE the user has
// received across every network they're connected to (or have been
// connected to during this session) into one chronological list. The
// store persists across reloads via localStorage; this view is just
// the renderer.
//
// What's NOT here yet — features deliberately deferred to keep the
// MVP small:
//   - Per-memo Reply: would need a server-aware compose UI that
//     re-sends through that connection's MemoServ. Plumb when the
//     user asks.
//   - Per-memo Delete: trivially `/msg MemoServ DEL N`, but we don't
//     parse the memo number yet, so we'd be guessing.
//   - Send-memo composer: same — the Advanced panel's MemoServ tab
//     has the form, so the inbox stays a viewer for now.
export function Inbox({ open, memos, onClose }: InboxProps) {
  // Newest first — the canonical mailbox order.
  const sorted = [...memos].sort((a, b) => b.timestamp - a.timestamp);
  return (
    <Modal open={open} onClose={onClose} title="Inbox">
      <div class="inbox-body">
        <div class="inbox-header">
          <span class="inbox-count">
            {memos.length === 0
              ? 'No memos yet.'
              : `${memos.length} memo${memos.length === 1 ? '' : 's'}`}
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
              Memos sent to you through your servers' <code>MemoServ</code> service
              will collect here.
            </p>
            <p class="inbox-empty-hint">
              On most networks: <code>/msg MemoServ HELP SEND</code> for instructions.
              You can also use the <strong>Advanced → Memos</strong> tab on a
              server's settings page to send / list / read memos directly.
            </p>
          </div>
        ) : (
          <ul class="inbox-list">
            {sorted.map((m) => (
              <li key={m.id} class={`inbox-row ${m.read ? '' : 'inbox-row-unread'}`}>
                <div class="inbox-row-meta">
                  <span class="inbox-row-server">{m.serverName || m.serverId || 'unknown server'}</span>
                  <span class="inbox-row-time">{formatTimestamp(m.timestamp)}</span>
                </div>
                <div class="inbox-row-text">{m.text}</div>
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
