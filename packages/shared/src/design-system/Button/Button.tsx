import type { JSX, ComponentChildren } from 'preact';
import './Button.css';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost';
export type ButtonSize = 'sm' | 'md';

type NativeButtonProps = Omit<JSX.ButtonHTMLAttributes<HTMLButtonElement>, 'children' | 'class' | 'className'>;

interface ButtonProps extends NativeButtonProps {
  variant?: ButtonVariant;
  // 'md' (default) — chunky hero/auth buttons. 'sm' — compact for card
  // footers, list rows, and inline modal actions where the variant style
  // still matters but the form-factor should match surrounding mono text.
  size?: ButtonSize;
  fullWidth?: boolean;
  loading?: boolean;
  children?: ComponentChildren;
}

export function Button({
  variant = 'primary',
  size = 'md',
  fullWidth = false,
  loading = false,
  disabled,
  type = 'button',
  children,
  ...rest
}: ButtonProps) {
  const classes = [
    'bds-btn',
    `bds-btn-${variant}`,
    `bds-btn-size-${size}`,
    fullWidth ? 'bds-btn-fullwidth' : '',
    loading ? 'bds-btn-loading' : '',
  ].filter(Boolean).join(' ');

  return (
    <button {...rest} type={type} class={classes} disabled={disabled || loading} aria-busy={loading || undefined}>
      {loading ? <span class="bds-btn-spinner" aria-hidden="true" /> : null}
      <span class="bds-btn-label">{children}</span>
    </button>
  );
}
