import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/preact';
import userEvent from '@testing-library/user-event';
import { Button } from './Button';

describe('Button', () => {
  it('renders children and fires onClick', async () => {
    const onClick = vi.fn();
    render(<Button onClick={onClick}>Click me</Button>);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Click me' }));
    expect(onClick).toHaveBeenCalledOnce();
  });

  it('applies variant + fullWidth classes', () => {
    render(<Button variant="secondary" fullWidth>Save</Button>);
    const btn = screen.getByRole('button', { name: 'Save' });
    expect(btn.className).toContain('bds-btn-secondary');
    expect(btn.className).toContain('bds-btn-fullwidth');
  });

  it('disables and shows spinner when loading', () => {
    render(<Button loading>Loading</Button>);
    const btn = screen.getByRole('button', { name: 'Loading' });
    expect(btn).toBeDisabled();
    expect(btn.getAttribute('aria-busy')).toBe('true');
    expect(btn.querySelector('.bds-btn-spinner')).toBeTruthy();
  });

  it('defaults type to button (prevents accidental form submit)', () => {
    render(<Button>Default</Button>);
    expect(screen.getByRole('button').getAttribute('type')).toBe('button');
  });

  it('forwards type=submit when explicitly set', () => {
    render(<Button type="submit">Send</Button>);
    expect(screen.getByRole('button').getAttribute('type')).toBe('submit');
  });
});
