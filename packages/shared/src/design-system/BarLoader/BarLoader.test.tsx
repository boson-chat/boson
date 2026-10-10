import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/preact';
import { BarLoader } from './BarLoader';

describe('BarLoader', () => {
  it('is an indeterminate progressbar by default', () => {
    render(<BarLoader />);
    const bar = screen.getByRole('progressbar', { name: 'Loading' });
    expect(bar.dataset.mode).toBe('indeterminate');
    expect(bar.hasAttribute('aria-valuenow')).toBe(false);
    expect(bar.style.height).toBe('2px');
  });

  it('reports determinate progress, clamped to 0–100', () => {
    const { rerender } = render(<BarLoader value={42.4} label="Uploading" />);
    const bar = screen.getByRole('progressbar', { name: 'Uploading' });
    expect(bar.dataset.mode).toBe('determinate');
    expect(bar.getAttribute('aria-valuenow')).toBe('42');
    expect(bar.style.getPropertyValue('--bds-bar-value')).toBe('42.4%');

    rerender(<BarLoader value={180} label="Uploading" />);
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('100');
  });

  it('takes a height and extra classes', () => {
    render(<BarLoader height={4} class="edge" />);
    const bar = screen.getByRole('progressbar');
    expect(bar.style.height).toBe('4px');
    expect(bar.className).toContain('edge');
  });
});
