import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/preact';
import userEvent from '@testing-library/user-event';
import { ListRow } from './ListRow';

describe('ListRow', () => {
  it('title, meta, subtitle and trailing', () => {
    const { container } = render(<ListRow title="kestrel" meta="#dev" subtitle="Friend" trailing={<button type="button">Call</button>} />);
    expect(container.querySelector('.bds-row-title')!.textContent).toBe('kestrel');
    expect(container.querySelector('.bds-row-meta')!.textContent).toBe('#dev');
    expect(container.querySelector('.bds-row-sub')!.textContent).toBe('Friend');
    expect(screen.getByRole('button', { name: 'Call' })).toBeTruthy();
    expect(container.querySelector('button.bds-row-main')).toBeNull();
  });
  it('onClick makes the body one named button, apart from the actions', async () => {
    const onClick = vi.fn();
    const act = vi.fn();
    render(<ListRow title="mira" onClick={onClick} ariaLabel="Open mira" trailing={<button type="button" onClick={act}>X</button>} />);
    const u = userEvent.setup();
    await u.click(screen.getByRole('button', { name: 'Open mira' }));
    await u.click(screen.getByRole('button', { name: 'X' }));
    expect(onClick).toHaveBeenCalledOnce();
    expect(act).toHaveBeenCalledOnce();
  });
  it('nav variant marks the selected entry current; li when asked', () => {
    const { container } = render(<ul><ListRow as="li" variant="nav" selected title="Friends" /></ul>);
    const li = container.querySelector('li')!;
    expect(li.className).toContain('bds-row-nav');
    expect(li.getAttribute('aria-current')).toBe('page');
  });
  it('title tone and size classes', () => {
    const { container } = render(<ListRow title="x" titleTone="danger" size="lg" unread />);
    expect(container.querySelector('.bds-row-title-danger')).toBeTruthy();
    expect(container.querySelector('.bds-row-lg.bds-row-unread')).toBeTruthy();
  });
});
