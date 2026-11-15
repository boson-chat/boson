import { X } from 'lucide-preact';
import { formatBytes, type Upload } from '../../modules/files';
import './Uploads.css';

// Uploads in progress in this channel, at the foot of the conversation:
// name, a progress bar (or "Queued", waiting its turn) and Cancel; a failed
// one says why until dismissed. With more than one still to go, Cancel all.
export function UploadProgress({ uploads, onCancel, onDismiss, onCancelAll }: {
  uploads: readonly Upload[];
  onCancel: (id: string) => void;
  onDismiss: (id: string) => void;
  onCancelAll?: () => void;
}) {
  if (uploads.length === 0) return null;
  const pending = uploads.filter((u) => u.status === 'queued' || u.status === 'uploading').length;
  return (
    <ul class="upload-progress" aria-label="Uploads">
      {pending > 1 && onCancelAll && (
        <li class="upload-progress-head">
          <span>{pending} uploads to go</span>
          <button type="button" class="upload-progress-btn upload-progress-cancel-all" onClick={onCancelAll}>
            Cancel all
          </button>
        </li>
      )}
      {uploads.map((u) => {
        const pct = u.size > 0 ? Math.min(100, Math.round((u.sent / u.size) * 100)) : 0;
        if (u.status === 'error') {
          return (
            <li key={u.id} class="upload-progress-row upload-progress-error" data-testid="upload-row">
              <span class="upload-progress-name">{u.name}</span>
              <span class="upload-progress-msg" role="alert">{u.error}</span>
              <button type="button" class="upload-progress-btn" aria-label={`Dismiss ${u.name}`} onClick={() => onDismiss(u.id)}>
                <X size={14} aria-hidden="true" />
              </button>
            </li>
          );
        }
        const done = u.status === 'done';
        const queued = u.status === 'queued';
        return (
          <li key={u.id} class="upload-progress-row" data-testid="upload-row" data-status={u.status}>
            <span class="upload-progress-name">{u.name}</span>
            <span
              class="upload-progress-bar"
              role="progressbar"
              aria-label={queued ? `${u.name} queued` : `Uploading ${u.name}`}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={done ? 100 : pct}
            >
              <span style={{ width: `${done ? 100 : pct}%` }} />
            </span>
            <span class="upload-progress-pct">
              {done ? 'Sent' : queued ? `Queued · ${formatBytes(u.size)}` : `${formatBytes(u.sent)} of ${formatBytes(u.size)}`}
            </span>
            {!done && (
              <button type="button" class="upload-progress-btn upload-progress-cancel" aria-label={`Cancel ${u.name}`} onClick={() => onCancel(u.id)}>
                Cancel
              </button>
            )}
          </li>
        );
      })}
    </ul>
  );
}
