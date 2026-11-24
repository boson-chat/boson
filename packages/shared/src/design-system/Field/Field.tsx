import type { ComponentChildren } from 'preact';
import { useId, useLayoutEffect, useRef } from 'preact/hooks';
import './Field.css';

interface FieldProps {
  label: string;
  optional?: boolean;
  hint?: string;
  error?: string;
  children?: ComponentChildren;
}

// The control a Field labels: its first input, textarea or Select trigger.
const CONTROL = 'input:not([type=hidden]), textarea, select, [role=combobox], [role=spinbutton]';

export function Field({ label, optional, hint, error, children }: FieldProps) {
  const base = useId();
  const ref = useRef<HTMLDivElement>(null);
  const labelRef = useRef<HTMLLabelElement>(null);
  const noteId = `${base}-note`;
  const note = error || hint;

  // Ties the label (and the hint or error) to the control, so a screen
  // reader names it: the label's `for` points at the control's id (given
  // one when it has none), and the hint describes it.
  useLayoutEffect(() => {
    const control = ref.current?.querySelector<HTMLElement>(CONTROL);
    const lbl = labelRef.current;
    if (!control || !lbl) return;
    if (!control.id) control.id = `${base}-control`;
    lbl.htmlFor = control.id;
    if (!control.hasAttribute('aria-label') && !control.hasAttribute('aria-labelledby') && control.tagName === 'BUTTON') {
      // A Select's trigger is a button: `for` doesn't name a button.
      lbl.id = lbl.id || `${base}-label`;
      control.setAttribute('aria-labelledby', lbl.id);
    }
    const described = (control.getAttribute('aria-describedby') ?? '').split(' ').filter((x) => x && x !== noteId);
    if (note) described.push(noteId);
    if (described.length) control.setAttribute('aria-describedby', described.join(' '));
    else control.removeAttribute('aria-describedby');
    // aria-invalid while the Field shows an error (one the control set
    // itself is left alone).
    if (error) { control.setAttribute('aria-invalid', 'true'); control.dataset['bdsInvalid'] = ''; }
    else if ('bdsInvalid' in control.dataset) { control.removeAttribute('aria-invalid'); delete control.dataset['bdsInvalid']; }
  });

  return (
    <div class="bds-field" ref={ref}>
      <label class="bds-field-label" ref={labelRef}>
        {label}
        {optional && <span class="bds-field-optional"> (optional)</span>}
      </label>
      {children}
      {error
        ? <div class="bds-field-error" id={noteId} role="alert">{error}</div>
        : hint ? <div class="bds-field-hint" id={noteId}>{hint}</div> : null}
    </div>
  );
}
