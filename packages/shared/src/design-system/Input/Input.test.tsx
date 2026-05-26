import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/preact';
import userEvent from '@testing-library/user-event';
import { Input } from './Input';

describe('Input', () => {
  it('forwards value and fires onInput', async () => {
    const onInput = vi.fn();
    render(<Input placeholder="email" value="" onInput={onInput} />);
    const input = screen.getByPlaceholderText('email') as HTMLInputElement;
    await userEvent.setup().type(input, 'a');
    expect(onInput).toHaveBeenCalled();
  });

  it('marks invalid via aria-invalid', () => {
    render(<Input placeholder="x" invalid />);
    expect(screen.getByPlaceholderText('x').getAttribute('aria-invalid')).toBe('true');
  });

  it('switches size classes', () => {
    render(<Input placeholder="small" inputSize="sm" />);
    expect(screen.getByPlaceholderText('small').className).toContain('bds-input-sm');
  });
});
