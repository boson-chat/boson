import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/preact';
import userEvent from '@testing-library/user-event';
import { PageHeader } from './PageHeader';

describe('PageHeader', () => {
  it('a heading, a sub and actions', () => {
    render(<PageHeader title="Calls" sub="2 missed" actions={<button type="button">Clear</button>} />);
    expect(screen.getByRole('heading', { name: 'Calls' })).toBeTruthy();
    expect(screen.getByText('2 missed')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Clear' })).toBeTruthy();
  });
  it('phones: a 44px back button', async () => {
    const onBack = vi.fn();
    render(<PageHeader layout="phone" title="Friends" onBack={onBack} backLabel="Back to chat" />);
    const back = screen.getByRole('button', { name: 'Back to chat' });
    expect(back.className).toContain('bds-btn-size-lg');
    await userEvent.setup().click(back);
    expect(onBack).toHaveBeenCalledOnce();
  });
});
