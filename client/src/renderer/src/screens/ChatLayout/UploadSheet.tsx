import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { FileText, Film, Music, Plus, X } from 'lucide-preact';
import { Button, Modal } from '@boson/shared';
import {
  batchQuotaCheck, fileTooLargeMessage, formatBytes, mediaFor, sanitizeFilename, splitExt, usageSummary,
  type FilesLimits, type FilesUsage,
} from '../../modules/files';
import { useFileDrop } from '../../shared/FileDrop/file-drop';
import './Uploads.css';

// Before anything is sent: the chosen files, each with its filename (what
// the link will be called — editable, the extension kept), an image
// thumbnail and its size; one optional caption (for a single file, beside
// it; for several, one for the batch); the total, and the user's usage on
// the files host the upload goes to, checked against the total. More files
// can be added (Add files, or dropped on the sheet) and any removed.
// Enter sends, Escape cancels.

export interface UploadItem {
  file: File;
  name: string;
}

interface Props {
  open: boolean;
  files: readonly File[];
  // Where it goes ("#general").
  target: string;
  limits: FilesLimits | null;
  // undefined: still loading; null: unavailable.
  usage?: FilesUsage | null;
  // The files host is the app account's, not the network's: "boson.chat".
  homeLabel?: string;
  // Something about the files last added ("You can send up to 20 files at
  // once…").
  notice?: string;
  onSend: (items: UploadItem[], caption: string) => void;
  onCancel: () => void;
  // More files (Add files, or dropped on the sheet).
  onAdd?: (files: File[]) => void;
  onRemove?: (file: File) => void;
  now?: number;
}

interface Row {
  key: number;
  file: File;
  name: string;
  thumb: string | null;
}

let rowSeq = 0;

// Past this a preview isn't worth decoding: the full image would be decoded
// for a 56px tile, which on a huge photo or GIF stalled the window right
// after the drop.
const THUMB_MAX_BYTES = 20 * 1024 * 1024;

function canThumb(file: File): boolean {
  return /^image\/(png|jpeg|gif|webp|avif)$/.test(file.type) && file.size <= THUMB_MAX_BYTES;
}

export function UploadSheet({ open, files, target, limits, usage, homeLabel, notice, onSend, onCancel, onAdd, onRemove, now }: Props) {
  const [rows, setRows] = useState<Row[]>([]);
  const [caption, setCaption] = useState('');
  const first = useRef<HTMLInputElement | null>(null);
  const picker = useRef<HTMLInputElement | null>(null);
  const thumbs = useRef(new Map<File, string>());

  // Rows follow `files`: new ones added (a thumbnail made), gone ones
  // dropped; names typed so far are kept.
  useEffect(() => {
    if (!open) return;
    setRows((rs) => {
      const have = new Map(rs.map((r) => [r.file, r]));
      const next = files.map((file) => have.get(file) ?? {
        key: ++rowSeq,
        file,
        name: file.name || 'file',
        thumb: canThumb(file) && typeof URL.createObjectURL === 'function' ? URL.createObjectURL(file) : null,
      });
      for (const r of next) if (r.thumb) thumbs.current.set(r.file, r.thumb);
      for (const r of rs) {
        if (!files.includes(r.file) && r.thumb) {
          URL.revokeObjectURL(r.thumb);
          thumbs.current.delete(r.file);
        }
      }
      return next;
    });
  }, [open, files]);
  useEffect(() => () => {
    thumbs.current.forEach((t) => URL.revokeObjectURL(t));
    thumbs.current.clear();
  }, []);

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
  const quota = useMemo(() => batchQuotaCheck(rows.map((r) => r.file.size), usage, now), [rows, usage, now]);
  const blocked = rows.length === 0 || rows.some((r) => tooLarge(r.file)) || !!quota;
  const many = rows.length > 1;

  const send = (): void => {
    if (blocked) return;
    onSend(rows.map((r) => ({ file: r.file, name: sanitizeFilename(r.name, r.file.name) })), caption.trim());
  };

  const update = (key: number, p: Partial<Row>): void => setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...p } : r)));
  const removeRow = (r: Row): void => {
    if (rows.length === 1) {
      onCancel();
      return;
    }
    if (onRemove) onRemove(r.file);
    else setRows((rs) => rs.filter((x) => x.key !== r.key));
  };

  const drop = useFileDrop({ disabled: !onAdd, onFiles: (fs) => onAdd?.(fs) });

  const onKeyDown = (e: KeyboardEvent): void => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      send();
    }
  };

  const pct = usage && usage.quota > 0 ? Math.min(100, (usage.used / usage.quota) * 100) : 0;
  const title = many ? `Upload ${rows.length} files to ${target}` : `Upload to ${target}`;
  const captionField = (label: string) => (
    <label class="upload-sheet-label">
      <span>Caption <em>(optional)</em></span>
      <input
        class="upload-sheet-input"
        type="text"
        value={caption}
        placeholder={many ? 'Say something about them' : 'Say something about it'}
        aria-label={label}
        onInput={(e) => setCaption((e.target as HTMLInputElement).value)}
      />
    </label>
  );

  return (
    <Modal open={open} onClose={onCancel} title={title}>
      <div class={`upload-sheet${drop.dragging ? ' upload-sheet-dragging' : ''}`} onKeyDown={onKeyDown} {...drop.handlers}>
        {homeLabel && (
          <p class="upload-sheet-home" data-testid="upload-home">
            Uploads to {homeLabel} — this network has no file storage of its own, so they count against your {homeLabel} quota.
          </p>
        )}
        <ul class="upload-sheet-list">
          {rows.map((r, i) => {
            const clean = sanitizeFilename(r.name, r.file.name);
            const big = tooLarge(r.file);
            const media = mediaFor(r.file.name);
            return (
              <li key={r.key} class={`upload-sheet-item${big ? ' upload-sheet-item-error' : ''}`} data-testid="upload-item">
                <div class="upload-sheet-thumb" aria-hidden="true">
                  {r.thumb
                    ? <img src={r.thumb} alt="" decoding="async" loading="lazy" />
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
                  {!many && captionField(`Caption for ${r.file.name}`)}
                </div>
                <button
                  type="button"
                  class="upload-sheet-remove"
                  aria-label={`Remove ${r.file.name}`}
                  title="Remove"
                  onClick={() => removeRow(r)}
                >
                  <X size={16} aria-hidden="true" />
                </button>
              </li>
            );
          })}
        </ul>

        {many && <div class="upload-sheet-batch-caption">{captionField('Caption for these files')}</div>}

        <div class="upload-sheet-summary">
          <span data-testid="upload-total">{rows.length === 1 ? '1 file' : `${rows.length} files`} · {formatBytes(total)}</span>
          {onAdd && (
            <>
              <Button variant="ghost" size="sm" onClick={() => picker.current?.click()}>
                <Plus size={14} aria-hidden="true" /> Add files
              </Button>
              <input
                ref={picker}
                type="file"
                multiple
                hidden
                data-testid="upload-sheet-add-input"
                onChange={(e) => {
                  const el = e.currentTarget as HTMLInputElement;
                  const picked = Array.from(el.files ?? []);
                  el.value = '';
                  if (picked.length) onAdd(picked);
                }}
              />
            </>
          )}
        </div>
        {notice && <div class="upload-sheet-notice" role="status">{notice}</div>}

        <UsageMeter usage={usage} pct={pct} now={now} over={quota?.message ?? null} />

        <div class="upload-sheet-actions">
          <Button variant="ghost" size="sm" onClick={onCancel}>Cancel</Button>
          <Button variant="primary" size="sm" disabled={blocked} onClick={send}>
            {many ? `Send ${rows.length} files` : 'Send'}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function UsageMeter({ usage, pct, now, over }: { usage?: FilesUsage | null; pct: number; now?: number; over: string | null }) {
  const summary = useMemo(() => (usage ? usageSummary(usage, now) : ''), [usage, now]);
  if (usage === null) return null;
  if (usage === undefined) return <div class="upload-usage upload-usage-loading" aria-live="polite">Checking your storage…</div>;
  return (
    <div class={`upload-usage${over ? ' upload-usage-over' : ''}`} data-testid="upload-usage">
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
      {over && <span class="upload-usage-warn" role="alert">{over}</span>}
    </div>
  );
}
