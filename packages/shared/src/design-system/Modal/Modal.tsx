import { useEffect, useRef, useState } from 'preact/hooks';
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

// EXIT_DURATION_MS must match the CSS `.bds-modal-backdrop` exit
// transition duration. We could read it from the computed style but
// hardcoding keeps the React state machine trivial — the exit
// animation is short and tweaks to the CSS are followed by tweaks
// here in the same PR. Source of truth lives in Modal.css's
// `.bds-modal-backdrop-exit` block.
const EXIT_DURATION_MS = 220;

export function Modal({ open, onClose, title, children, closeOnBackdropClick = true, size = 'default' }: ModalProps) {
  // Hold the latest onClose in a ref so the keydown effect doesn't re-bind
  // (and steal focus from controlled inputs) on every parent render.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  // `mounted` controls actual DOM presence. We keep the modal in the
  // tree for EXIT_DURATION_MS after `open` flips false so the CSS
  // exit transition has time to run. Synchronously dropping the
  // backdrop would cut the animation off mid-frame.
  const [mounted, setMounted] = useState(open);
  // `visible` toggles the `.is-open` class. Decoupled from `open`
  // because we need to apply `.is-open` AFTER the initial paint with
  // `.is-open` absent — otherwise the transition has no "from" state
  // to animate from and the modal pops in instantly.
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (open) {
      setMounted(true);
      // Two rAFs: first paints the closed-state DOM, the second
      // flips to is-open and triggers the transition. requestAnimationFrame
      // alone isn't enough in some browsers — paint may not have
      // happened by the time the first callback runs.
      const r1 = requestAnimationFrame(() => {
        const r2 = requestAnimationFrame(() => setVisible(true));
        return () => cancelAnimationFrame(r2);
      });
      return () => cancelAnimationFrame(r1);
    } else {
      setVisible(false);
      const t = setTimeout(() => setMounted(false), EXIT_DURATION_MS);
      return () => clearTimeout(t);
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCloseRef.current();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [open]);

  if (!mounted) return null;

  return (
    <div
      class={`bds-modal-backdrop ${visible ? 'is-open' : ''}`}
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
