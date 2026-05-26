import type { ComponentChildren } from 'preact';
import './Field.css';

interface FieldProps {
  label: string;
  optional?: boolean;
  hint?: string;
  error?: string;
  children?: ComponentChildren;
}

export function Field({ label, optional, hint, error, children }: FieldProps) {
  return (
    <div class="bds-field">
      <label class="bds-field-label">
        {label}
        {optional && <span class="bds-field-optional"> (optional)</span>}
      </label>
      {children}
      {error
        ? <div class="bds-field-error" role="alert">{error}</div>
        : hint ? <div class="bds-field-hint">{hint}</div> : null}
    </div>
  );
}
