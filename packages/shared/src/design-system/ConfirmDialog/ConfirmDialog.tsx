import type { ComponentChildren } from 'preact';
import { useEffect, useRef } from 'preact/hooks';
import { Button } from '../Button/Button';
import { Layer } from '../Layer/Layer';
import { Modal } from '../Modal/Modal';
import './ConfirmDialog.css';

export interface ConfirmDialogProps {
  open: boolean;
  /** The question: "Leave Nebula?". Also the dialog's accessible name. */
  title: string;
  /** What happens, in a sentence or two. */
  children?: ComponentChildren;
  /** The action being confirmed: "Leave server". */
  confirmLabel: string;
  onConfirm: () => void;
  /** Destructive (the default): the confirm button is red. */
  danger?: boolean;
  cancelLabel?: string;
  onCancel: () => void;
  /**
   * A safer way forward that becomes the main button (leaving guest mode:
   * "Create account"); the confirm then steps back to a quieter danger
   * button.
   */
  alternative?: { label: string; onClick: () => void };
}

// "Are you sure?" for an action that can't be undone: a compact Modal (a
// bottom-docked card on phones) with the action, Cancel and, optionally, a
// safer alternative as the main button. Rendered above everything (another
// Modal included); Esc and the backdrop cancel. Focus starts on the safe
// choice, so Enter never destroys anything by accident.
export function ConfirmDialog({
  open, title, children, confirmLabel, onConfirm, danger = true, cancelLabel = 'Cancel', onCancel, alternative,
}: ConfirmDialogProps) {
  const safe = useRef<HTMLDivElement>(null);
  const cancelRef = useRef(onCancel);
  cancelRef.current = onCancel;

  // Esc cancels this dialog only: caught before a Modal underneath (which
  // listens on window too) would close as well.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return;
      e.stopImmediatePropagation();
      e.preventDefault();
      cancelRef.current();
    };
    window.addEventListener('keydown', onKey, true);
    // After the Layer has rendered the buttons.
    const t = setTimeout(() => safe.current?.querySelector<HTMLButtonElement>('[data-safe]')?.focus(), 0);
    return () => { window.removeEventListener('keydown', onKey, true); clearTimeout(t); };
  }, [open]);

  return (
    <Layer class="bds-confirm-layer">
      <Modal open={open} onClose={onCancel} title={title} size="compact">
        <div class="bds-confirm" ref={safe}>
          {children != null && <div class="bds-confirm-body">{children}</div>}
          <div class={`bds-confirm-actions${alternative ? ' bds-confirm-actions-alt' : ''}`}>
            <Button variant="ghost" onClick={onCancel} data-safe={alternative ? undefined : ''}>{cancelLabel}</Button>
            {alternative ? (
              <>
                <Button variant="secondary" tone="danger" onClick={onConfirm}>{confirmLabel}</Button>
                <Button variant="primary" onClick={alternative.onClick} data-safe="">{alternative.label}</Button>
              </>
            ) : (
              <Button variant={danger ? 'danger' : 'primary'} onClick={onConfirm}>{confirmLabel}</Button>
            )}
          </div>
        </div>
      </Modal>
    </Layer>
  );
}
