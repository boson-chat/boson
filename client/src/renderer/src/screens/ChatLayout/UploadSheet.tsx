import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { FileText, Film, Music, X } from 'lucide-preact';
import { Button, Modal } from '@boson/shared';
import {
  fileTooLargeMessage, formatBytes, mediaFor, sanitizeFilename, splitExt, usageSummary,
  type FilesLimits, type FilesUsage,
} from '../../modules/files';
import './Uploads.css';

// Before anything is sent: the chosen files, each with its filename (what
// the link will be called — editable, the extension kept), an image
// thumbnail, its size and an optional caption, and the user's usage on
// this network's files host. Enter sends, Escape cancels.

export interface UploadItem {
  file: File;
  name: string;
  caption: string;
}

interface Props {
  open: boolean;
  files: readonly File[];
  // Where it goes ("#general").
  target: string;
  limits: FilesLimits | null;
  // undefined: still loading; null: unavailable.
  usage?: FilesUsage | null;
  onSend: (items: UploadItem[]) => void;
  onCancel: () => void;
  now?: number;
}

interface Row {
  key: number;
  file: File;
  name: string;
  caption: string;
  thumb: string | null;
}

let rowSeq = 0;

function canThumb(file: File): boolean {
  return /^image\/(png|jpeg|gif|webp|avif)$/.test(file.type);
}

export function UploadSheet({ open, files, target, limits, usage, onSend, onCancel, now }: Props) {
  const [rows, setRows] = useState<Row[]>([]);
  const first = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!open) return undefined;
    const made = files.map((file) => ({
      key: ++rowSeq,
      file,
      name: file.name || 'file',
      caption: '',
      thumb: canThumb(file) && typeof URL.createObjectURL === 'function' ? URL.createObjectURL(file) : null,
    }));
    setRows(made);
    return () => { made.forEach((r) => { if (r.thumb) URL.revokeObjectURL(r.thumb); }); };
  }, [open, files]);

  // Focus the first filename with its stem selected, as a rename would.
  useEffect(() => {
    const el = first.current;
    if (!open || !el) return;
    const t = setTimeout(() => {
      el.focus();
      const [stem] = splitExt(el.value);
      el.setSelectionRange(0, stem.length);
    }, 0);
    return () => clearTimeout(t);
  }, [open, rows.length > 0]);

  const maxFile = limits?.max_file_bytes ?? 0;
  const tooLarge = (f: File): boolean => maxFile > 0 && f.size > maxFile;
  const total = rows.reduce((s, r) => s + r.file.size, 0);
  const blocked = rows.length === 0 || rows.some((r) => tooLarge(r.file));
  const overQuota = !!usage && usage.quota > 0 && usage.used + total > usage.quota;

  const send = (): void => {
    if (blocked) return;
    onSend(rows.map((r) => ({ file: r.file, name: sanitizeFilename(r.name, r.file.name), caption: r.caption.trim() })));
  };

  const update = (key: number, p: Partial<Row>): void => setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...p } : r)));
  const removeRow = (key: number): void => {
    setRows((rs) => {
      const gone = rs.find((r) => r.key === key);
      if (gone?.thumb) URL.revokeObjectURL(gone.thumb);
      const next = rs.filter((r) => r.key !== key);
      if (next.length === 0) onCancel();
      return next;
    });
  };

  const onKeyDown = (e: KeyboardEvent): void => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      send();
    }
  };

  const pct = usage && usage.quota > 0 ? Math.min(100, (usage.used / usage.quota) * 100) : 0;
  const title = rows.length > 1 ? `Upload ${rows.length} files to ${target}` : `Upload to ${target}`;

  return (
    <Modal open={open} onClose={onCancel} title={title}>
      <div class="upload-sheet" onKeyDown={onKeyDown}>
        <ul class="upload-sheet-list">
          {rows.map((r, i) => {
            const clean = sanitizeFilename(r.name, r.file.name);
            const big = tooLarge(r.file);
            const media = mediaFor(r.file.name);
            return (
              <li key={r.key} class={`upload-sheet-item${big ? ' upload-sheet-item-error' : ''}`} data-testid="upload-item">
                <div class="upload-sheet-thumb" aria-hidden="true">
                  {r.thumb
                    ? <img src={r.thumb} alt="" />
                    : media === 'video' ? <Film size={22} /> : media === 'audio' ? <Music size={22} /> : <FileText size={22} />}
                </div>
                <div class="upload-sheet-fields">
                  <label class="upload-sheet-label">
                    <span>Filename</span>
                    <input
                      ref={i === 0 ? first : undefined}
                      class="upload-sheet-input"
                      type="text"
                      spellcheck={false}
                      value={r.name}
                      aria-label={`Filename for ${r.file.name}`}
                      onInput={(e) => update(r.key, { name: (e.target as HTMLInputElement).value })}
                      onFocus={(e) => {
                        const el = e.currentTarget as HTMLInputElement;
                        const [stem] = splitExt(el.value);
                        el.setSelectionRange(0, stem.length);
                      }}
                    />
                  </label>
                  <div class="upload-sheet-meta">
                    <span class="upload-sheet-size">{formatBytes(r.file.size)}</span>
                    {clean !== r.name.trim() && <span class="upload-sheet-as">Uploads as <code>{clean}</code></span>}
                  </div>
                  {big && <div class="upload-sheet-error" role="alert">{fileTooLargeMessage(maxFile, { name: clean, size: r.file.size })}</div>}
                  <label class="upload-sheet-label">
                    <span>Caption <em>(optional)</em></span>
                    <input
                      class="upload-sheet-input"
                      type="text"
                      value={r.caption}
                      placeholder="Say something about it"
                      aria-label={`Caption for ${r.file.name}`}
                      onInput={(e) => update(r.key, { caption: (e.target as HTMLInputElement).value })}
                    />
                  </label>
                </div>
                <button
                  type="button"
                  class="upload-sheet-remove"
                  aria-label={`Remove ${r.file.name}`}
                  title="Remove"
                  onClick={() => removeRow(r.key)}
                >
                  <X size={16} aria-hidden="true" />
                </button>
              </li>
            );
          })}
        </ul>

        <UsageMeter usage={usage} pct={pct} now={now} overQuota={overQuota} />

        <div class="upload-sheet-actions">
          <Button variant="ghost" size="sm" onClick={onCancel}>Cancel</Button>
          <Button variant="primary" size="sm" disabled={blocked} onClick={send}>
            {rows.length > 1 ? `Send ${rows.length} files` : 'Send'}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function UsageMeter({ usage, pct, now, overQuota }: { usage?: FilesUsage | null; pct: number; now?: number; overQuota: boolean }) {
  const summary = useMemo(() => (usage ? usageSummary(usage, now) : ''), [usage, now]);
  if (usage === null) return null;
  if (usage === undefined) return <div class="upload-usage upload-usage-loading" aria-live="polite">Checking your storage…</div>;
  return (
    <div class={`upload-usage${overQuota ? ' upload-usage-over' : ''}`} data-testid="upload-usage">
      <div
        class="upload-usage-bar"
        role="meter"
        aria-label="Upload storage used"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(pct)}
      >
        <span style={{ width: `${pct}%` }} />
      </div>
      <span class="upload-usage-text">{summary}</span>
      {overQuota && <span class="upload-usage-warn">These files may not fit in what's left.</span>}
    </div>
  );
}
