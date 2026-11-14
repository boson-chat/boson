// @vitest-environment jsdom
// jsdom, not happy-dom: happy-dom elements lack ondragenter/ondragover/…,
// so Preact would listen for "DragOver" and never see a real "dragover".
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen } from '@testing-library/preact';
import { FileDropArea } from './FileDropArea';
import { matchesAccept } from './file-drop';
import { installDropGuard } from '../drop-guard';
import { drag } from './drag-test-utils';

const png = (name = 'a.png') => new File(['x'], name, { type: 'image/png' });
const txt = () => new File(['hi'], 'notes.txt', { type: 'text/plain' });

function setup(props: Partial<Parameters<typeof FileDropArea>[0]> = {}) {
  const onFile = vi.fn();
  const onReject = vi.fn();
  const utils = render(
    <FileDropArea accept="image/*" onFile={onFile} onReject={onReject} {...props}>
      <div data-testid="child"><span data-testid="grandchild">Preview</span></div>
    </FileDropArea>,
  );
  const area = utils.container.querySelector('.file-drop')!;
  return { ...utils, area, onFile, onReject, child: screen.getByTestId('child'), grandchild: screen.getByTestId('grandchild') };
}

afterEach(() => { document.body.innerHTML = ''; });

describe('matchesAccept', () => {
  it('matches wildcards, exact types and extensions like <input accept>', () => {
    expect(matchesAccept(png(), 'image/*')).toBe(true);
    expect(matchesAccept(txt(), 'image/*')).toBe(false);
    expect(matchesAccept(png(), 'image/jpeg, image/png')).toBe(true);
    expect(matchesAccept(new File(['{}'], 'Sunset.JSON'), '.json,application/json')).toBe(true);
    expect(matchesAccept(new File(['{}'], 'x', { type: 'application/json' }), '.json,application/json')).toBe(true);
    expect(matchesAccept(txt(), '.json,application/json')).toBe(false);
    expect(matchesAccept(txt(), '')).toBe(true);
    expect(matchesAccept(txt(), undefined)).toBe(true);
  });
});

describe('useFileDrop / FileDropArea', () => {
  it('shows "Drop to upload" while a file is dragged over, without flickering over children', () => {
    const { area, child, grandchild } = setup();
    expect(screen.queryByText('Drop to upload')).toBeNull();
    drag(area, 'dragenter');
    expect(screen.getByText('Drop to upload')).toBeInTheDocument();
    expect(area).toHaveAttribute('data-dragging', 'true');
    // Moving onto a child: enter(child) fires before leave(area).
    drag(child, 'dragenter');
    drag(area, 'dragleave');
    drag(grandchild, 'dragenter');
    drag(child, 'dragleave');
    expect(screen.getByText('Drop to upload')).toBeInTheDocument();
    drag(grandchild, 'dragleave');
    expect(screen.queryByText('Drop to upload')).toBeNull();
    expect(area).not.toHaveAttribute('data-dragging');
  });

  it('the overlay is hidden from assistive tech', () => {
    const { area } = setup();
    drag(area, 'dragenter');
    expect(area.querySelector('.file-drop-overlay')).toHaveAttribute('aria-hidden', 'true');
  });

  it('claims dragover only for drags that carry files', () => {
    const { area } = setup();
    expect(drag(area, 'dragover').defaultPrevented).toBe(true);
    expect(drag(area, 'dragover', { types: ['text/plain', 'text/uri-list'] }).defaultPrevented).toBe(false);
    drag(area, 'dragenter', { types: ['text/plain'] });
    expect(screen.queryByText('Drop to upload')).toBeNull();
  });

  it('hands the dropped file to onFile and clears the drag state', () => {
    const { area, onFile, onReject } = setup();
    drag(area, 'dragenter');
    const file = png();
    const e = drag(area, 'drop', { files: [file] });
    expect(e.defaultPrevented).toBe(true);
    expect(onFile).toHaveBeenCalledWith(file);
    expect(onReject).not.toHaveBeenCalled();
    expect(screen.queryByText('Drop to upload')).toBeNull();
  });

  it('uses the first of several files', () => {
    const { area, onFile } = setup();
    const first = png('first.png');
    drag(area, 'drop', { files: [first, png('second.png')] });
    expect(onFile).toHaveBeenCalledTimes(1);
    expect(onFile).toHaveBeenCalledWith(first);
  });

  it('rejects a file of the wrong type without calling onFile', () => {
    const { area, onFile, onReject } = setup();
    const file = txt();
    drag(area, 'drop', { files: [file] });
    expect(onReject).toHaveBeenCalledWith(file);
    expect(onFile).not.toHaveBeenCalled();
  });

  it('ignores drops while disabled (and shows no drop state)', () => {
    const { area, onFile, onReject } = setup({ disabled: true });
    drag(area, 'dragenter');
    expect(screen.queryByText('Drop to upload')).toBeNull();
    const e = drag(area, 'drop', { files: [png()] });
    expect(e.defaultPrevented).toBe(true); // still swallowed: never navigates
    expect(onFile).not.toHaveBeenCalled();
    expect(onReject).not.toHaveBeenCalled();
  });

  it('a drop with no files is a no-op', () => {
    const { area, onFile, onReject } = setup();
    drag(area, 'drop', { files: [] });
    expect(onFile).not.toHaveBeenCalled();
    expect(onReject).not.toHaveBeenCalled();
  });
});

describe('FileDropArea with the window drop guard and outer drop handlers', () => {
  it('keeps the drop from reaching outer handlers, while the guard still blocks files elsewhere', () => {
    const uninstall = installDropGuard(window);
    try {
      const outer = vi.fn();
      const windowSeen = vi.fn();
      const onFile = vi.fn();
      const { container } = render(
        <div data-testid="outer">
          <FileDropArea accept="image/*" onFile={onFile}><span>Preview</span></FileDropArea>
          <div data-testid="elsewhere" />
        </div>,
      );
      const outerEl = screen.getByTestId('outer');
      outerEl.addEventListener('drop', outer);
      outerEl.addEventListener('dragover', outer);
      window.addEventListener('drop', windowSeen);
      const area = container.querySelector('.file-drop')!;

      drag(area, 'dragover');
      drag(area, 'drop', { files: [png()] });
      expect(onFile).toHaveBeenCalledTimes(1);
      expect(outer).not.toHaveBeenCalled();
      expect(windowSeen).not.toHaveBeenCalled();

      // Off the picker the guard still swallows file drops (no navigation).
      const off = drag(screen.getByTestId('elsewhere'), 'drop', { files: [png()] });
      expect(off.defaultPrevented).toBe(true);
      expect(windowSeen).toHaveBeenCalledTimes(1);
      expect(onFile).toHaveBeenCalledTimes(1);

      // Text drags over the picker pass straight through to the guard.
      const text = drag(area, 'drop', { types: ['text/uri-list'] });
      expect(text.defaultPrevented).toBe(true); // by the guard: not editable
      expect(windowSeen).toHaveBeenCalledTimes(2);
      window.removeEventListener('drop', windowSeen);
    } finally {
      uninstall();
    }
  });
});
