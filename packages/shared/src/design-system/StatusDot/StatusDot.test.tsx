import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/preact';
import { StatusDot } from './StatusDot';

describe('StatusDot', () => {
  it('is decoration without a label', () => {
    const { container } = render(<StatusDot status="online" />);
    expect(container.querySelector('.bds-dot-online')!.getAttribute('aria-hidden')).toBe('true');
  });
  it('is an image with a label, sized by --bds-dot', () => {
    render(<StatusDot status="dnd" size={12} label="Do not disturb" ring />);
    const el = screen.getByRole('img', { name: 'Do not disturb' });
    expect(el.getAttribute('style')).toMatch(/--bds-dot: ?12px/);
    expect(el.className).toContain('bds-dot-ring');
  });
});
