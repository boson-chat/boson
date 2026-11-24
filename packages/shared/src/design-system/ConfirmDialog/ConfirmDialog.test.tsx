import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/preact';
import userEvent from '@testing-library/user-event';
import { ConfirmDialog } from './ConfirmDialog';
import { Modal } from '../Modal/Modal';

describe('ConfirmDialog', () => {
  it('asks, then confirms', async () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    render(<ConfirmDialog open title="Leave Nebula?" confirmLabel="Leave server" onConfirm={onConfirm} onCancel={onCancel}>
      You'll be disconnected.
    </ConfirmDialog>);
    const dialog = await screen.findByRole('dialog', { name: 'Leave Nebula?' });
    expect(dialog).toHaveTextContent("You'll be disconnected.");
    await userEvent.setup().click(screen.getByRole('button', { name: 'Leave server' }));
    expect(onConfirm).toHaveBeenCalledOnce();
    expect(onCancel).not.toHaveBeenCalled();
  });

  it('renders into <body>, outside its parent', async () => {
    const { container } = render(<div><ConfirmDialog open title="Sure?" confirmLabel="Yes" onConfirm={() => {}} onCancel={() => {}} /></div>);
    const dialog = await screen.findByRole('dialog', { name: 'Sure?' });
    expect(container.contains(dialog)).toBe(false);
    expect(dialog.closest('.bds-confirm-layer')).toBeTruthy();
  });

  it('focuses Cancel, so Enter never confirms by accident', async () => {
    render(<ConfirmDialog open title="Sure?" confirmLabel="Delete" onConfirm={() => {}} onCancel={() => {}} />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus());
  });

  it('with an alternative: it is the main button and takes the focus', async () => {
    const alt = vi.fn();
    render(<ConfirmDialog open title="Leave guest mode?" confirmLabel="Erase and sign in" onConfirm={() => {}} onCancel={() => {}}
      alternative={{ label: 'Create account', onClick: alt }} />);
    const create = await screen.findByRole('button', { name: 'Create account' });
    expect(create.className).toContain('bds-btn-primary');
    expect(screen.getByRole('button', { name: 'Erase and sign in' }).className).not.toContain('bds-btn-primary');
    await waitFor(() => expect(create).toHaveFocus());
    await userEvent.setup().click(create);
    expect(alt).toHaveBeenCalledOnce();
  });

  it('Esc cancels it without closing a Modal underneath', async () => {
    const onCancel = vi.fn();
    const onCloseModal = vi.fn();
    render(
      <Modal open onClose={onCloseModal} title="Settings">
        <ConfirmDialog open title="Sure?" confirmLabel="Yes" onConfirm={() => {}} onCancel={onCancel} />
      </Modal>,
    );
    await screen.findByRole('dialog', { name: 'Sure?' });
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(onCancel).toHaveBeenCalledOnce();
    expect(onCloseModal).not.toHaveBeenCalled();
  });

  it('renders nothing while closed', () => {
    render(<ConfirmDialog open={false} title="Sure?" confirmLabel="Yes" onConfirm={() => {}} onCancel={() => {}} />);
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
