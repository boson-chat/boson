import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/preact';
import { Badge } from './Badge';

describe('Badge', () => {
  it('renders the label in its tone', () => {
    const { container } = render(<Badge tone="ops">OPS</Badge>);
    const el = container.querySelector('.bds-badge')!;
    expect(el.textContent).toBe('OPS');
    expect(el.classList.contains('bds-badge-ops')).toBe(true);
  });

  it('takes a neutral tone, a tooltip and a layout class', () => {
    const { container } = render(<Badge tone="neutral" title="Not signed in" class="guest-badge">guest</Badge>);
    const el = container.querySelector('.bds-badge')!;
    expect(el.classList.contains('bds-badge-neutral')).toBe(true);
    expect(el.classList.contains('guest-badge')).toBe(true);
    expect(el.getAttribute('title')).toBe('Not signed in');
  });
  it('defaults to info', () => {
    const { container } = render(<Badge>Default</Badge>);
    expect(container.firstElementChild!.className).toBe('bds-badge bds-badge-info');
  });
  it('accent and neutral tones', () => {
    const { container } = render(<><Badge tone="accent">On</Badge><Badge tone="neutral">Off now</Badge></>);
    const [on, off] = Array.from(container.querySelectorAll('.bds-badge'));
    expect(on.className).toContain('bds-badge-accent');
    expect(off.className).toContain('bds-badge-neutral');
    expect(off.textContent).toBe('Off now');
  });
});
