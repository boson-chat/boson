import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/preact';
import { Count } from './Count';

describe('Count', () => {
  it('renders nothing for 0', () => {
    const { container } = render(<Count value={0} />);
    expect(container.innerHTML).toBe('');
  });
  it('shows the number and caps at max+', () => {
    const { container, rerender } = render(<Count value={7} />);
    expect(container.textContent).toBe('7');
    rerender(<Count value={150} />);
    expect(container.textContent).toBe('99+');
  });
  it('tone, size and overlay classes; a label makes it an image', () => {
    const { container } = render(<Count value={3} tone="danger" size="sm" overlay label="3 missed calls" />);
    const el = container.querySelector('.bds-count')!;
    expect(el.className).toContain('bds-count-danger');
    expect(el.className).toContain('bds-count-sm');
    expect(el.className).toContain('bds-count-overlay');
    expect(el.getAttribute('aria-label')).toBe('3 missed calls');
  });
});
