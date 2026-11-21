import type { ComponentChildren, JSX } from 'preact';
import { Button } from '../Button/Button';
import './Toast.css';

interface ToastProps {
  /** Avatar or icon on the left. */
  leading?: ComponentChildren;
  title?: ComponentChildren;
  /** Small mono text after the title (where it happened, "video call"). */
  meta?: ComponentChildren;
  body?: ComponentChildren;
  bodyTone?: 'success';
  /** The toast's body is a button that opens what it's about. */
  onOpen?: () => void;
  openLabel?: string;
  /**
   * Buttons. layout "stack" puts them under the text (desktop cards);
   * "row" keeps everything on one line (the incoming-call banner).
   */
  actions?: ComponentChildren;
  layout?: 'stack' | 'row';
  /** desktop: a card · phone: a banner from the top. */
  surface?: 'desktop' | 'phone';
  /** An × in the corner. */
  onDismiss?: () => void;
  dismissLabel?: string;
  dismissIcon?: ComponentChildren;
  /** The time left, as a bar along the bottom. */
  timerMs?: number;
  paused?: boolean;
  /** Ringing: the border glows green (steady under reduced motion). */
  ringing?: boolean;
  /** Text only, centred (a status line: "kestrel is busy"). */
  status?: boolean;
  role?: JSX.AriaRole;
  ariaLabel?: string;
  class?: string;
  boxProps?: JSX.HTMLAttributes<HTMLDivElement>;
}

// Every toast, banner and status pop-up: one card.
export function Toast({
  leading, title, meta, body, bodyTone, onOpen, openLabel, actions, layout = 'stack', surface = 'desktop',
  onDismiss, dismissLabel = 'Dismiss', dismissIcon, timerMs, paused = false, ringing = false, status = false,
  role, ariaLabel, class: extra, boxProps,
}: ToastProps) {
  const cls = [
    'bds-toast', `bds-toast-${surface}`, `bds-toast-${layout}`,
    onDismiss ? 'bds-toast-dismissable' : '', ringing ? 'bds-toast-ringing' : '',
    status ? 'bds-toast-status' : '', paused ? 'bds-toast-paused' : '', extra ?? '',
  ].filter(Boolean).join(' ');
  const content = (
    <>
      {leading != null && <span class="bds-toast-lead">{leading}</span>}
      <span class="bds-toast-text">
        {(title != null || meta != null) && (
          <span class="bds-toast-head">
            {title != null && <span class="bds-toast-title">{title}</span>}
            {meta != null && <span class="bds-toast-meta">{meta}</span>}
          </span>
        )}
        {body != null && <span class={`bds-toast-body${bodyTone ? ` bds-toast-body-${bodyTone}` : ''}`}>{body}</span>}
      </span>
    </>
  );
  return (
    <div {...boxProps} class={cls} role={role} aria-label={ariaLabel}>
      {onOpen
        ? <button type="button" class="bds-toast-main" onClick={onOpen} aria-label={openLabel}>{content}</button>
        : <span class="bds-toast-main">{content}</span>}
      {actions != null && <div class="bds-toast-actions">{actions}</div>}
      {onDismiss && (
        <Button variant="ghost" size={surface === 'phone' ? 'md' : 'sm'} class="bds-toast-x" aria-label={dismissLabel}
          icon={dismissIcon ?? <span aria-hidden="true">×</span>} onClick={onDismiss} />
      )}
      {timerMs != null && <span class="bds-toast-bar" aria-hidden="true" style={{ animationDuration: `${timerMs}ms` }} />}
    </div>
  );
}
