// Stop stray drag-and-drop from navigating the window. A browser's default for
// a file or link dropped onto a page is to navigate to it — in the desktop app
// that would replace the app with an arbitrary document. The shell also
// cancels such navigations (guardNavigation in platform/wails.ts); this keeps
// the drop from even being attempted, so nothing flashes or gets opened.
//
// Rules, applied only to drops nothing else handled (`defaultPrevented`):
//   - Files: always swallowed. The app has no file-drop upload target today;
//     a future one should call preventDefault() itself and will be left alone.
//   - Anything else (links, text): swallowed unless it lands on an editable
//     field, so dragging text/URLs into the composer or an input still works
//     as the browser normally does (inserting text, not navigating).

function isEditable(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  const el = target.closest('input, textarea, [contenteditable]');
  if (!el) return false;
  if (el instanceof HTMLInputElement) return !el.disabled && !el.readOnly;
  if (el instanceof HTMLTextAreaElement) return !el.disabled && !el.readOnly;
  return (el as HTMLElement).isContentEditable;
}

function shouldBlock(e: DragEvent): boolean {
  if (e.defaultPrevented) return false;
  const types = e.dataTransfer?.types ?? [];
  if (Array.from(types).includes('Files')) return true;
  return !isEditable(e.target);
}

function onDrag(e: DragEvent): void {
  if (!shouldBlock(e)) return;
  e.preventDefault();
  // Show the "not allowed" cursor instead of the copy/link one.
  if (e.type === 'dragover' && e.dataTransfer) e.dataTransfer.dropEffect = 'none';
}

// Bubble phase on window, so component-level drop handlers run first and can
// claim the event with preventDefault().
export function installDropGuard(target: Window = window): () => void {
  target.addEventListener('dragover', onDrag);
  target.addEventListener('drop', onDrag);
  return () => {
    target.removeEventListener('dragover', onDrag);
    target.removeEventListener('drop', onDrag);
  };
}
