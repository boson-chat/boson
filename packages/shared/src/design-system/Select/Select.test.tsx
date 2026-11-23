import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/preact';
import { useState } from 'preact/hooks';
import { Modal } from '../Modal/Modal';
import { Select, type SelectOption } from './Select';

const ROLES: SelectOption<string>[] = [
  { value: 'voice', label: 'Voice' },
  { value: 'halfop', label: 'Half-op', description: 'Can kick and set voice' },
  { value: 'op', label: 'Op' },
  { value: 'owner', label: 'Owner', disabled: true },
  { value: 'founder', label: 'Founder' },
];

function Harness({ initial = 'voice', onChange, ...rest }: { initial?: string; onChange?: (v: string) => void; presentation?: 'popover' | 'sheet' }) {
  const [v, setV] = useState(initial);
  return <Select label="Role" value={v} options={ROLES} onChange={(x) => { setV(x); onChange?.(x); }} {...rest} />;
}

const trigger = (): HTMLElement => screen.getByLabelText(/^Role/);
const list = (): HTMLElement => screen.getByRole('listbox');
const key = (el: Element, k: string): void => { fireEvent.keyDown(el, { key: k }); };

describe('Select', () => {
  it('is a button that opens a listbox; shows the value', () => {
    render(<Harness />);
    const t = trigger();
    expect(t.tagName).toBe('BUTTON');
    expect(t.getAttribute('aria-haspopup')).toBe('listbox');
    expect(t.getAttribute('aria-expanded')).toBe('false');
    expect(t.textContent).toContain('Voice');
    expect(screen.queryByRole('listbox')).toBeNull();
    fireEvent.click(t);
    expect(t.getAttribute('aria-expanded')).toBe('true');
    expect(t.getAttribute('aria-controls')).toBe(list().id);
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual(['✓Voice', 'Half-opCan kick and set voice', 'Op', 'Owner', 'Founder']);
    expect(screen.getByRole('option', { name: /Voice/ }).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByRole('option', { name: /Owner/ }).getAttribute('aria-disabled')).toBe('true');
    expect(document.activeElement).toBe(list());
  });

  it('a click picks; a disabled option does nothing; picking the same value fires nothing', () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    fireEvent.click(trigger());
    fireEvent.click(screen.getByRole('option', { name: /Owner/ }));
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByRole('listbox')).toBeTruthy();
    fireEvent.click(screen.getByRole('option', { name: /Voice/ }));
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.queryByRole('listbox')).toBeNull();
    fireEvent.click(trigger());
    fireEvent.click(screen.getByRole('option', { name: /^Op/ }));
    expect(onChange).toHaveBeenCalledWith('op');
    expect(trigger().textContent).toContain('Op');
    expect(document.activeElement).toBe(trigger());
  });

  it('keyboard: arrows skip disabled, Home/End, Enter picks, focus returns', () => {
    const onChange = vi.fn();
    render(<Harness initial="op" onChange={onChange} />);
    key(trigger(), 'ArrowDown');
    const l = list();
    expect(l.getAttribute('aria-activedescendant')).toBe(screen.getByRole('option', { name: /^Op/ }).id);
    key(l, 'ArrowDown'); // skips Owner
    expect(l.getAttribute('aria-activedescendant')).toBe(screen.getByRole('option', { name: /Founder/ }).id);
    key(l, 'ArrowDown'); // stays at the end
    expect(l.getAttribute('aria-activedescendant')).toBe(screen.getByRole('option', { name: /Founder/ }).id);
    key(l, 'Home');
    expect(l.getAttribute('aria-activedescendant')).toBe(screen.getByRole('option', { name: /Voice/ }).id);
    key(l, 'End');
    key(l, 'ArrowUp');
    expect(l.getAttribute('aria-activedescendant')).toBe(screen.getByRole('option', { name: /^Op/ }).id);
    key(l, 'ArrowUp');
    key(l, 'Enter');
    expect(onChange).toHaveBeenCalledWith('halfop');
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(document.activeElement).toBe(trigger());
  });

  it('Space and Enter open; Escape closes without a change and only closes the list', () => {
    const onChange = vi.fn();
    const onModalClose = vi.fn();
    render(<Modal open onClose={onModalClose} title="Dialog"><Harness onChange={onChange} /></Modal>);
    key(trigger(), ' ');
    key(list(), 'ArrowDown');
    key(list(), 'Escape');
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
    expect(onModalClose).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(trigger());
    key(trigger(), 'Enter');
    expect(screen.getByRole('listbox')).toBeTruthy();
    // Rendered outside the modal, so its overflow can't clip it.
    expect(document.querySelector('.bds-modal')!.contains(list())).toBe(false);
    expect(list().closest('.bds-select-layer')).toBeTruthy();
  });

  it('type-ahead: a letter jumps, repeats cycle, a word matches', () => {
    render(<Harness />);
    let now = 1_000;
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
    key(trigger(), 'o'); // closed: opens on the match
    const l = list();
    const active = (): string => document.getElementById(l.getAttribute('aria-activedescendant')!)!.textContent!;
    expect(active()).toContain('Op');
    key(l, 'f');
    expect(active()).toContain('Founder');
    now += 1_000;
    key(l, 'f'); // only one F: stays
    expect(active()).toContain('Founder');
    now += 1_000;
    key(l, 'h');
    expect(active()).toContain('Half-op');
    now += 1_000;
    key(l, 'v');
    now += 100;
    key(l, 'o');
    expect(active()).toContain('Voice');
    now += 100;
    key(l, 'x'); // no match: stays
    expect(active()).toContain('Voice');
    clock.mockRestore();
  });

  it('an outside press closes it', () => {
    render(<div><span>outside</span><Harness /></div>);
    fireEvent.click(trigger());
    fireEvent.pointerDown(screen.getByRole('option', { name: /^Op/ }));
    expect(screen.getByRole('listbox')).toBeTruthy();
    fireEvent.pointerDown(screen.getByText('outside'));
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('disabled: does not open', () => {
    render(<Select label="Role" value="op" options={ROLES} onChange={() => {}} disabled />);
    fireEvent.click(trigger());
    key(trigger(), 'ArrowDown');
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('a value not in the options shows the placeholder', () => {
    render(<Select label="History" value="" placeholder="Unknown" options={ROLES} onChange={() => {}} />);
    expect(screen.getByLabelText(/^History/).textContent).toContain("Unknown");
  });

  it('labelledBy names it from a visible label', () => {
    render(<div><span id="lbl">Message history</span><Select labelledBy="lbl" value="op" options={ROLES} onChange={() => {}} /></div>);
    expect(screen.getByLabelText(/Message history/).tagName).toBe('BUTTON');
  });

  it('flips above the trigger near the bottom of the viewport', () => {
    render(<Harness presentation="popover" />);
    const t = trigger();
    t.getBoundingClientRect = () => ({ top: 700, bottom: 730, left: 20, right: 220, width: 200, height: 30, x: 20, y: 700, toJSON: () => ({}) });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 760 });
    const sh = vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(200);
    try {
      fireEvent.click(t);
      const l = list();
      expect(l.classList.contains('bds-select-up')).toBe(true);
      expect(l.style.maxHeight).toBe('200px');
      expect(l.style.top).toBe(`${700 - 4 - 200}px`);
    } finally {
      sh.mockRestore();
    }
  });

  it('as a sheet: a dialog of 44px options; a pick slides it away', async () => {
    vi.useFakeTimers();
    try {
      const onChange = vi.fn();
      render(<Harness presentation="sheet" onChange={onChange} />);
      fireEvent.click(trigger());
      expect(screen.getByRole('dialog', { name: 'Role' })).toBeTruthy();
      expect(screen.getByRole('option', { name: /Founder/ }).className).toContain('bds-menu-item-lg');
      fireEvent.click(screen.getByRole('option', { name: /Founder/ }));
      expect(onChange).toHaveBeenCalledWith('founder');
      await act(async () => { vi.advanceTimersByTime(400); });
      expect(screen.queryByRole('dialog')).toBeNull();
      expect(document.activeElement).toBe(trigger());
    } finally {
      vi.useRealTimers();
    }
  });
});
