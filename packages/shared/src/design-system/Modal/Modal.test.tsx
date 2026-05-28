import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/preact';
import userEvent from '@testing-library/user-event';
import { Modal } from './Modal';

describe('Modal', () => {
  it('renders nothing when closed from the start', () => {
    render(<Modal open={false} onClose={() => {}}>body</Modal>);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('renders title + body when open', () => {
    render(<Modal open onClose={() => {}} title="Confirm">Are you sure?</Modal>);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByText('Confirm')).toBeInTheDocument();
    expect(screen.getByText('Are you sure?')).toBeInTheDocument();
  });

  it('calls onClose when close button clicked', async () => {
    const onClose = vi.fn();
    render(<Modal open onClose={onClose} title="X">body</Modal>);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('calls onClose on Escape key', () => {
    const onClose = vi.fn();
    render(<Modal open onClose={onClose}>body</Modal>);
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('keeps the dialog in the DOM during the exit animation, then unmounts', async () => {
    // The Modal uses a delayed-unmount pattern so the CSS exit
    // transition can run before the DOM is torn down. Tested via the
    // visible `.is-open` class disappearing while the dialog is still
    // mounted; eventually (after ~220ms) the dialog unmounts.
    const { rerender } = render(<Modal open onClose={() => {}}>body</Modal>);
    expect(screen.getByRole('dialog')).toBeInTheDocument();

    rerender(<Modal open={false} onClose={() => {}}>body</Modal>);
    // Immediately after `open` flips false the dialog is still present
    // (the exit transition needs DOM to animate). The wrapping backdrop
    // should have lost its is-open class.
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    const backdrop = screen.getByRole('dialog').parentElement;
    expect(backdrop?.classList.contains('is-open')).toBe(false);

    // After the exit duration the dialog is fully unmounted. waitFor
    // polls until that resolves so the test doesn't depend on the
    // exact EXIT_DURATION_MS constant from Modal.tsx.
    await waitFor(
      () => expect(screen.queryByRole('dialog')).toBeNull(),
      { timeout: 1000 },
    );
  });
});
