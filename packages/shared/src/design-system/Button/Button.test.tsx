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

describe('Button: variants, sizes, icons', () => {
  it.each(['primary', 'secondary', 'ghost', 'danger', 'success'] as const)('renders the %s variant', (v) => {
    render(<Button variant={v}>X</Button>);
    expect(screen.getByRole('button').className).toContain(`bds-btn-${v}`);
  });

  it.each(['sm', 'md', 'lg', 'xl'] as const)('renders the %s size', (s) => {
    render(<Button size={s}>X</Button>);
    expect(screen.getByRole('button').className).toContain(`bds-btn-size-${s}`);
  });

  it('icon-only: square, named by aria-label, no label span', () => {
    render(<Button icon={<svg />} aria-label="Decline" variant="danger" size="lg" />);
    const btn = screen.getByRole('button', { name: 'Decline' });
    expect(btn.className).toContain('bds-btn-icon-only');
    expect(btn.querySelector('.bds-btn-label')).toBeNull();
    expect(btn.querySelector('.bds-btn-icon')).toBeTruthy();
  });

  it('an icon with a label keeps the label', () => {
    render(<Button icon={<svg />}>Call back</Button>);
    const btn = screen.getByRole('button', { name: 'Call back' });
    expect(btn.className).not.toContain('bds-btn-icon-only');
  });

  it('icon-only requires an aria-label (type check)', () => {
    // @ts-expect-error — an icon-only button must be named.
    render(<Button icon={<svg />} />);
    expect(screen.getByRole('button')).toBeTruthy();
  });

  it('pressed sets aria-pressed; attention, tone and shape add their classes', () => {
    render(<Button variant="secondary" pressed tone="success" attention shape="round">Mute</Button>);
    const btn = screen.getByRole('button', { name: 'Mute' });
    expect(btn.getAttribute('aria-pressed')).toBe('true');
    expect(btn.className).toContain('bds-btn-pressed');
    expect(btn.className).toContain('bds-btn-tone-success');
    expect(btn.className).toContain('bds-btn-attention');
    expect(btn.className).toContain('bds-btn-round');
  });

  it('square is the default shape', () => {
    render(<Button>X</Button>);
    expect(screen.getByRole('button').className).not.toContain('bds-btn-round');
  });
});
