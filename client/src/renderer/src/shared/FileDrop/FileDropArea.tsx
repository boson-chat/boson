import type { ComponentChildren } from 'preact';
import { useFileDrop, type FileDropOptions } from './file-drop';
import './FileDrop.css';

// Wraps a file picker's whole area (preview plus its text) as a drop target.
// While a file is dragged over it, shows a dashed accent outline, a subtle
// tint and the "Drop to upload" label. The overlay is aria-hidden and the
// area isn't focusable: keyboard and screen-reader use stay on the picker's
// own button / <input type="file">.
export function FileDropArea({ children, class: className, label = 'Drop to upload', ...opts }: FileDropOptions & {
  children: ComponentChildren;
  class?: string;
  label?: string;
}) {
  const { dragging, handlers } = useFileDrop(opts);
  return (
    <div
      class={`file-drop ${dragging ? 'file-drop-active' : ''} ${className ?? ''}`.trim()}
      data-dragging={dragging ? 'true' : undefined}
      {...handlers}
    >
      {children}
      {dragging && (
        <div class="file-drop-overlay" aria-hidden="true">
          <span class="file-drop-label">{label}</span>
        </div>
      )}
    </div>
  );
}

// The visible "or drop … here" hint next to a picker's button.
export function FileDropHint({ children = 'or drop an image here', id }: { children?: ComponentChildren; id?: string }) {
  return <span class="file-drop-hint" id={id}>{children}</span>;
}
