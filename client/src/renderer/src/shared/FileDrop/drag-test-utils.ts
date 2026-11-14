import { act } from '@testing-library/preact';

// Dispatch a drag event carrying `files` (test helper). jsdom has no
// DragEvent/DataTransfer, so a plain cancelable Event gets a minimal
// dataTransfer stub. Returns the event so callers can check defaultPrevented.
export type DragType = 'dragenter' | 'dragover' | 'dragleave' | 'drop';
export function drag(target: Element, type: DragType, opts: { files?: File[]; types?: string[] } = {}): Event {
  const files = opts.files ?? [];
  const types = opts.types ?? ['Files'];
  const e = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(e, 'dataTransfer', { value: { types, files, dropEffect: 'none' } });
  act(() => { target.dispatchEvent(e); });
  return e;
}

// A full drag of `files` onto `target`: enter, over, drop.
export function dropFiles(target: Element, files: File[]): Event {
  drag(target, 'dragenter');
  drag(target, 'dragover');
  return drag(target, 'drop', { files });
}
