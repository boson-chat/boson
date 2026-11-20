import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/preact';
import { Badge } from './Badge';

describe('Badge', () => {
  it('renders its tone and the call site class', () => {
    const { container } = render(<Badge tone="warn" class="x-tag" title="Guest">guest</Badge>);
    const el = container.querySelector('.bds-badge')!;
    expect(el.className).toBe('bds-badge bds-badge-warn x-tag');
    expect(el.getAttribute('title')).toBe('Guest');
    expect(el.textContent).toBe('guest');
  });
});
