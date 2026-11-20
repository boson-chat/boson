import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/preact';
import { Badge } from './Badge';

describe('Badge', () => {
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
