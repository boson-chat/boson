import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/preact';
import userEvent from '@testing-library/user-event';
import { Toast } from './Toast';

describe('Toast', () => {
  it('opens, dismisses and shows its time left', async () => {
    const onOpen = vi.fn();
    const onDismiss = vi.fn();
    const { container } = render(<Toast title="mira" meta="#dev" body="hi" onOpen={onOpen} openLabel="Open mira" onDismiss={onDismiss} timerMs={6000} paused />);
    const u = userEvent.setup();
    await u.click(screen.getByRole('button', { name: 'Open mira' }));
    await u.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(onOpen).toHaveBeenCalledOnce();
    expect(onDismiss).toHaveBeenCalledOnce();
    expect((container.querySelector('.bds-toast-bar') as HTMLElement).style.animationDuration).toBe('6000ms');
    expect(container.querySelector('.bds-toast-paused')).toBeTruthy();
  });
  it('row layout, phone surface, ringing, role', () => {
    render(<Toast layout="row" surface="phone" ringing role="alertdialog" ariaLabel="kestrel is calling" title="kestrel" meta="video call"
      actions={<button type="button">Accept</button>} />);
    const el = screen.getByRole('alertdialog', { name: 'kestrel is calling' });
    expect(el.className).toContain('bds-toast-row');
    expect(el.className).toContain('bds-toast-phone');
    expect(el.className).toContain('bds-toast-ringing');
    expect(screen.queryByRole('button', { name: 'Dismiss' })).toBeNull();
  });
  it('a status line', () => {
    const { container } = render(<Toast status role="status" title="kestrel is busy" />);
    expect(container.querySelector('.bds-toast-status')!.getAttribute('role')).toBe('status');
  });
});
