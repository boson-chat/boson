import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/preact';
import userEvent from '@testing-library/user-event';
import { Tabs } from './Tabs';

const tabs = [
  { id: 'login', label: 'Login' },
  { id: 'signup', label: 'Signup' },
];

describe('Tabs', () => {
  it('marks the active tab via aria-selected', () => {
    render(<Tabs tabs={tabs} active="login" onChange={() => {}} />);
    expect(screen.getByRole('tab', { name: 'Login' }).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByRole('tab', { name: 'Signup' }).getAttribute('aria-selected')).toBe('false');
  });

  it('fires onChange with the clicked tab id', async () => {
    const onChange = vi.fn();
    render(<Tabs tabs={tabs} active="login" onChange={onChange} />);
    await userEvent.setup().click(screen.getByRole('tab', { name: 'Signup' }));
    expect(onChange).toHaveBeenCalledWith('signup');
  });

  it('renders a sliding indicator whose left + width move when the active tab changes', () => {
    // jsdom doesn't lay out elements, so getBoundingClientRect returns
    // zeros. Stub it deterministically so the indicator math has real
    // numbers to work with — the test cares about *which* values get
    // applied, not the actual layout.
    const original = HTMLElement.prototype.getBoundingClientRect;
    const widths = new Map<string, { left: number; width: number }>([
      ['Login',  { left: 0,   width: 100 }],
      ['Signup', { left: 100, width: 100 }],
    ]);
    HTMLElement.prototype.getBoundingClientRect = function () {
      // The tablist itself reports as the union of the two tabs.
      if (this.getAttribute('role') === 'tablist') {
        return { left: 0, top: 0, right: 200, bottom: 32, width: 200, height: 32, x: 0, y: 0, toJSON: () => ({}) } as DOMRect;
      }
      const m = widths.get(this.textContent ?? '');
      if (m) {
        return { left: m.left, top: 0, right: m.left + m.width, bottom: 32, width: m.width, height: 32, x: m.left, y: 0, toJSON: () => ({}) } as DOMRect;
      }
      return original.call(this);
    };
    try {
      const { rerender, container } = render(<Tabs tabs={tabs} active="login" onChange={() => {}} />);
      const indicator = container.querySelector('.bds-tab-indicator') as HTMLElement | null;
      expect(indicator).not.toBeNull();
      expect(indicator!.style.left).toBe('0px');
      expect(indicator!.style.width).toBe('100px');

      rerender(<Tabs tabs={tabs} active="signup" onChange={() => {}} />);
      const moved = container.querySelector('.bds-tab-indicator') as HTMLElement;
      expect(moved.style.left).toBe('100px');
      expect(moved.style.width).toBe('100px');
    } finally {
      HTMLElement.prototype.getBoundingClientRect = original;
    }
  });
});
