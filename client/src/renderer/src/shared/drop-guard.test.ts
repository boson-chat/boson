import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { installDropGuard } from './drop-guard';

// happy-dom's DragEvent doesn't populate dataTransfer from the init dict, so
// build a plain cancelable Event and attach a minimal dataTransfer stub.
function dragEvent(type: 'dragover' | 'drop', types: string[]): Event {
  const e = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(e, 'dataTransfer', { value: { types, dropEffect: 'copy' } });
  return e;
}

describe('installDropGuard', () => {
  let uninstall: () => void;
  beforeEach(() => { uninstall = installDropGuard(window); });
  afterEach(() => { uninstall(); document.body.innerHTML = ''; });

  it('swallows file drops anywhere, including on inputs', () => {
    const input = document.createElement('input');
    document.body.append(input);
    for (const target of [document.body, input]) {
      const e = dragEvent('drop', ['Files']);
      target.dispatchEvent(e);
      expect(e.defaultPrevented).toBe(true);
    }
  });

  it('swallows link drops on non-editable areas', () => {
    const div = document.createElement('div');
    document.body.append(div);
    const e = dragEvent('drop', ['text/uri-list', 'text/plain']);
    div.dispatchEvent(e);
    expect(e.defaultPrevented).toBe(true);
  });

  it('leaves text/link drops into editable fields alone', () => {
    const ta = document.createElement('textarea');
    document.body.append(ta);
    const e = dragEvent('drop', ['text/plain']);
    ta.dispatchEvent(e);
    expect(e.defaultPrevented).toBe(false);
  });

  it('does not interfere with a component that handled the drop itself', () => {
    const zone = document.createElement('div');
    document.body.append(zone);
    let handled = false;
    zone.addEventListener('drop', (ev) => { ev.preventDefault(); handled = true; });
    const e = dragEvent('drop', ['Files']);
    zone.dispatchEvent(e);
    expect(handled).toBe(true);
    expect(e.defaultPrevented).toBe(true);
  });
});
