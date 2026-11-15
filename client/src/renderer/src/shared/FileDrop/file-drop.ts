import { useRef, useState } from 'preact/hooks';

// Drag-and-drop for a file picker. Spread `handlers` on the picker's whole
// area (preview plus its text); a dropped file goes to `onFile`, exactly like
// one chosen through the picker's <input type="file">.
//
//   - Only drags that carry Files are touched. Text and link drags pass
//     through untouched, so the window drop guard (shared/drop-guard.ts) keeps
//     treating them as before.
//   - File drags are claimed with preventDefault() + stopPropagation() on
//     dragover and drop, so neither the window guard nor any other drop
//     handler further up (chat, the server rail) acts on them as well.
//   - `dragging` follows a dragenter/dragleave counter, so moving over the
//     area's children doesn't flicker it.
//   - More than one file: the first is used (`onFile`), or all of them
//     (`onFiles`, for multi-file targets like the chat). A file that doesn't match
//     `accept` goes to `onReject` instead. While `disabled` (e.g. an upload is
//     in flight) the drop is swallowed and ignored.

export interface FileDropOptions {
  // Same syntax as <input accept>: ".json", "image/*", "image/png", comma-separated.
  accept?: string;
  disabled?: boolean;
  onFile?: (file: File) => void;
  // Every dropped file that matches `accept` (instead of onFile).
  onFiles?: (files: File[]) => void;
  onReject?: (file: File) => void;
}

export interface FileDropHandlers {
  onDragEnter: (e: DragEvent) => void;
  onDragOver: (e: DragEvent) => void;
  onDragLeave: (e: DragEvent) => void;
  onDrop: (e: DragEvent) => void;
}

export interface FileDrop {
  // A file drag is over the area (and the area isn't disabled).
  dragging: boolean;
  handlers: FileDropHandlers;
}

export function hasFiles(e: DragEvent): boolean {
  return Array.from(e.dataTransfer?.types ?? []).includes('Files');
}

// Whether `file` matches an <input accept> string. An empty accept matches
// everything, as it does on the input.
export function matchesAccept(file: File, accept: string | undefined): boolean {
  const tokens = (accept ?? '').split(',').map((t) => t.trim().toLowerCase()).filter(Boolean);
  if (tokens.length === 0) return true;
  const name = file.name.toLowerCase();
  const type = (file.type || '').toLowerCase();
  return tokens.some((t) => {
    if (t.startsWith('.')) return name.endsWith(t);
    if (t.endsWith('/*')) return type.startsWith(t.slice(0, -1));
    return type === t;
  });
}

export function useFileDrop({ accept, disabled = false, onFile, onFiles, onReject }: FileDropOptions): FileDrop {
  const depth = useRef(0);
  const [over, setOver] = useState(false);

  const onDragEnter = (e: DragEvent): void => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    depth.current += 1;
    setOver(true);
  };

  const onDragOver = (e: DragEvent): void => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.dataTransfer) e.dataTransfer.dropEffect = disabled ? 'none' : 'copy';
  };

  const onDragLeave = (e: DragEvent): void => {
    if (!hasFiles(e)) return;
    depth.current = Math.max(0, depth.current - 1);
    if (depth.current === 0) setOver(false);
  };

  const onDrop = (e: DragEvent): void => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    e.stopPropagation();
    depth.current = 0;
    setOver(false);
    if (disabled) return;
    if (onFiles) {
      const all = Array.from(e.dataTransfer?.files ?? []);
      const ok = all.filter((f) => matchesAccept(f, accept));
      all.filter((f) => !ok.includes(f)).forEach((f) => onReject?.(f));
      if (ok.length > 0) onFiles(ok);
      return;
    }
    const file = e.dataTransfer?.files?.[0];
    if (!file) return;
    if (matchesAccept(file, accept)) onFile?.(file);
    else onReject?.(file);
  };

  return {
    dragging: over && !disabled,
    handlers: { onDragEnter, onDragOver, onDragLeave, onDrop },
  };
}
