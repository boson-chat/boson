import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/preact';
import { useState } from 'preact/hooks';
import { ColorPicker } from './ColorPicker';

function Harness({ initial = '#d97706', onChange = vi.fn(), swatches = ['#070709', '#E2E2EA', '#e2e2ea'] }) {
  const [value, setValue] = useState(initial);
  return (
    <>
      <ColorPicker label="Accent" value={value} swatches={swatches} onChange={(hex) => { setValue(hex); onChange(hex); }} />
      <output data-testid="value">{value}</output>
      <button type="button">elsewhere</button>
    </>
  );
}

const open = () => fireEvent.click(screen.getByRole('button', { name: 'Accent colour picker' }));
const dialog = () => screen.queryByRole('dialog', { name: 'Pick Accent' });
const value = () => screen.getByTestId('value').textContent;

describe('ColorPicker', () => {
  it('opens a popover from the swatch, and closes on Escape, an outside click, or the swatch', () => {
    render(<Harness />);
    const swatch = screen.getByRole('button', { name: 'Accent colour picker' });
    expect(swatch).toHaveAttribute('aria-expanded', 'false');
    expect(dialog()).toBeNull();
    open();
    expect(swatch).toHaveAttribute('aria-expanded', 'true');
    expect(dialog()).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Hex' })).toHaveValue('#d97706');

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(dialog()).toBeNull();
    expect(swatch).toHaveFocus();

    open();
    fireEvent.pointerDown(screen.getByRole('button', { name: 'elsewhere' }));
    expect(dialog()).toBeNull();

    open();
    open();
    expect(dialog()).toBeNull();
  });

  it('the hue strip turns the colour round the wheel, keeping saturation and brightness', () => {
    const onChange = vi.fn();
    render(<Harness initial="#ff0000" onChange={onChange} />);
    open();
    fireEvent.input(screen.getByRole('slider', { name: 'Hue' }), { target: { value: '120' } });
    expect(onChange).toHaveBeenLastCalledWith('#00ff00');
    expect(value()).toBe('#00ff00');
    expect(screen.getByRole('textbox', { name: 'Hex' })).toHaveValue('#00ff00');
  });

  it('opacity writes an 8-digit hex, and back to 6 at 100%', () => {
    render(<Harness initial="#ff0000" />);
    open();
    const alpha = screen.getByRole('slider', { name: 'Opacity' });
    expect(alpha).toHaveValue('100');
    fireEvent.input(alpha, { target: { value: '50' } });
    expect(value()).toBe('#ff000080');
    fireEvent.input(alpha, { target: { value: '100' } });
    expect(value()).toBe('#ff0000');
  });

  it('arrow keys move through saturation (left/right) and brightness (up/down), shift for big steps', () => {
    render(<Harness initial="#ff0000" />);
    open();
    const area = screen.getByRole('slider', { name: 'Saturation and brightness' });
    expect(area).toHaveAttribute('aria-valuetext', 'Saturation 100%, brightness 100%');
    fireEvent.keyDown(area, { key: 'ArrowDown', shiftKey: true });
    fireEvent.keyDown(area, { key: 'ArrowLeft', shiftKey: true });
    expect(area).toHaveAttribute('aria-valuetext', 'Saturation 90%, brightness 90%');
    expect(value()).toBe('#e61717');
    fireEvent.keyDown(area, { key: 'ArrowRight' });
    expect(area).toHaveAttribute('aria-valuetext', 'Saturation 91%, brightness 90%');
  });

  it('dragging in the square picks saturation × brightness from the pointer', () => {
    render(<Harness initial="#ff0000" />);
    open();
    const square = screen.getByRole('slider', { name: 'Saturation and brightness' }).parentElement!;
    square.getBoundingClientRect = () => ({ left: 0, top: 0, width: 200, height: 100, right: 200, bottom: 100, x: 0, y: 0, toJSON: () => ({}) });
    fireEvent.pointerDown(square, { clientX: 100, clientY: 50, pointerId: 1 });
    expect(value()).toBe('#804040');
    fireEvent.pointerMove(square, { clientX: 400, clientY: -20, buttons: 1, pointerId: 1 }); // clamped
    expect(value()).toBe('#ff0000');
    fireEvent.pointerMove(square, { clientX: 0, clientY: 100, buttons: 0 }); // not pressed: ignored
    expect(value()).toBe('#ff0000');
  });

  it('takes a typed hex, with or without #, and ignores half-typed ones', () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    open();
    const hex = screen.getByRole('textbox', { name: 'Hex' });
    fireEvent.input(hex, { target: { value: '#88c' } });
    expect(value()).toBe('#8888cc');
    onChange.mockClear();
    fireEvent.input(hex, { target: { value: '#88c0' } }); // valid 4-digit (#rgba)
    expect(value()).toBe('#8888cc00');
    fireEvent.input(hex, { target: { value: '88C0D' } });
    expect(onChange).toHaveBeenCalledTimes(1);
    fireEvent.input(hex, { target: { value: '88C0D0' } });
    expect(value()).toBe('#88c0d0');
    fireEvent.input(hex, { target: { value: 'zz' } });
    fireEvent.focusOut(hex); // a browser's blur also sends focusout, which onBlur listens for under preact/compat
    expect(hex).toHaveValue('#88c0d0');
  });

  it("offers the theme's other colours once each, and applies one on click", () => {
    render(<Harness />);
    open();
    const chips = screen.getAllByRole('button', { name: /^Use / });
    expect(chips.map((c) => c.getAttribute('aria-label'))).toEqual(['Use #070709', 'Use #e2e2ea']);
    fireEvent.click(chips[1]!);
    expect(value()).toBe('#e2e2ea');
    expect(screen.getByRole('textbox', { name: 'Hex' })).toHaveValue('#e2e2ea');
  });

  it('follows a value changed from outside (the text box)', () => {
    const { rerender } = render(<ColorPicker label="Accent" value="#ff0000" onChange={() => {}} />);
    open();
    rerender(<ColorPicker label="Accent" value="#0000ff" onChange={() => {}} />);
    expect(screen.getByRole('textbox', { name: 'Hex' })).toHaveValue('#0000ff');
    expect(screen.getByRole('slider', { name: 'Hue' })).toHaveValue('240');
  });

  it('the eyedropper is offered only where the platform has one', async () => {
    render(<Harness />);
    open();
    expect(screen.queryByRole('button', { name: 'Pick a colour from the screen' })).toBeNull();
    (globalThis as { EyeDropper?: unknown }).EyeDropper = class { open = async () => ({ sRGBHex: '#123456' }); };
    try {
      fireEvent.keyDown(document, { key: 'Escape' });
      open();
      fireEvent.click(screen.getByRole('button', { name: 'Pick a colour from the screen' }));
      await vi.waitFor(() => expect(value()).toBe('#123456'));
    } finally {
      delete (globalThis as { EyeDropper?: unknown }).EyeDropper;
    }
  });

  it('sits below the swatch in viewport coordinates, or above it near the bottom of the window', () => {
    const rect = (top: number, left: number) => () =>
      ({ top, left, bottom: top + 24, right: left + 28, width: 28, height: 24, x: left, y: top, toJSON: () => ({}) });
    const spy = vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(300);
    vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(232);
    try {
      window.innerHeight = 900;
      window.innerWidth = 1440;
      render(<Harness />);
      const swatch = screen.getByRole('button', { name: 'Accent colour picker' });
      swatch.getBoundingClientRect = rect(100, 200);
      open();
      expect(dialog()).toHaveStyle({ top: '130px', left: '200px' }); // 100 + 24 + 6

      fireEvent.keyDown(document, { key: 'Escape' });
      swatch.getBoundingClientRect = rect(800, 1400);
      open();
      // 800 - 6 - 300 above; pushed in from the right edge (1440 - 232 - 8).
      expect(dialog()).toHaveStyle({ top: '494px', left: '1200px' });
    } finally {
      spy.mockRestore();
      vi.restoreAllMocks();
    }
  });
});
