import { useEffect, useRef } from 'preact/hooks';
import type { ComponentChildren } from 'preact';
import './Modal.css';

interface ModalProps {
  open: boolean;
  onClose: () => void;
  title?: string;
  children?: ComponentChildren;
  closeOnBackdropClick?: boolean;
  // 'default' (~720px) for forms + settings; 'wide' (~960px) for content
  // that benefits from extra horizontal room — e.g. the server directory
  // card grid needs room for 2-3 columns.
  size?: 'default' | 'wide';
}

export function Modal({ open, onClose, title, children, closeOnBackdropClick = true, size = 'default' }: ModalProps) {
  // Hold the latest onClose in a ref so the keydown effect doesn't re-bind
  // (and steal focus from controlled inputs) on every parent render.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCloseRef.current();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [open]);

  if (!open) return null;

  return (
    <div
      class="bds-modal-backdrop"
      onClick={() => { if (closeOnBackdropClick) onClose(); }}
    >
      <div
        class={`bds-modal ${size === 'wide' ? 'bds-modal-wide' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
      >
        {title && (
          <header class="bds-modal-header">
            <h2 class="bds-modal-title">{title}</h2>
            <button class="bds-modal-close" type="button" onClick={onClose} aria-label="Close">×</button>
          </header>
        )}
        <div class="bds-modal-body">{children}</div>
      </div>
    </div>
  );
}
