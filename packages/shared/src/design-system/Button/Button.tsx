import type { JSX, ComponentChildren, Ref } from 'preact';
import './Button.css';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'success';
// sm 28px (dense rows, toolbars) · md 34px (default) · lg 44px (phones: the
// minimum touch target) · xl 72px (the full-screen call's Accept / Decline).
export type ButtonSize = 'sm' | 'md' | 'lg' | 'xl';
// Colours the label / icon of a secondary or ghost button: a green call
// icon on a neutral button, a red "Remove" link.
export type ButtonTone = 'success' | 'danger' | 'accent';
// Every button is a rounded rectangle. 'round' exists for one place only,
// the full-screen incoming call (see DESIGN.md), so it can be flipped back
// to circles with one prop if wanted.
export type ButtonShape = 'square' | 'round';

type NativeButtonProps = Omit<JSX.ButtonHTMLAttributes<HTMLButtonElement>, 'children' | 'class' | 'className' | 'icon' | 'size'>;

interface BaseProps extends NativeButtonProps {
  variant?: ButtonVariant;
  size?: ButtonSize;
  tone?: ButtonTone;
  shape?: ButtonShape;
  fullWidth?: boolean;
  loading?: boolean;
  /** A toggle button (mute, camera): sets aria-pressed and the "on" look. */
  pressed?: boolean;
  /** A gentle pulse that asks to be pressed (Accept on a ringing call). Static under reduced motion. */
  attention?: boolean;
  /** Layout hook for the call site (margins, grid placement). Not for restyling. */
  class?: string;
  buttonRef?: Ref<HTMLButtonElement>;
}

// With a text label: the icon (optional) goes before it.
interface LabelledProps extends BaseProps {
  children: ComponentChildren;
  icon?: ComponentChildren;
}

// Icon-only: square, and it must say what it does.
interface IconOnlyProps extends BaseProps {
  children?: undefined;
  icon: ComponentChildren;
  'aria-label': string;
}

export type ButtonProps = LabelledProps | IconOnlyProps;

export function Button({
  variant = 'primary',
  size = 'md',
  tone,
  shape = 'square',
  fullWidth = false,
  loading = false,
  pressed,
  attention = false,
  disabled,
  type = 'button',
  icon,
  children,
  class: extra,
  buttonRef,
  ...rest
}: ButtonProps) {
  const iconOnly = icon != null && (children == null || children === false);
  const classes = [
    'bds-btn',
    `bds-btn-${variant}`,
    `bds-btn-size-${size}`,
    tone ? `bds-btn-tone-${tone}` : '',
    iconOnly ? 'bds-btn-icon-only' : '',
    shape === 'round' ? 'bds-btn-round' : '',
    fullWidth ? 'bds-btn-fullwidth' : '',
    loading ? 'bds-btn-loading' : '',
    pressed ? 'bds-btn-pressed' : '',
    attention ? 'bds-btn-attention' : '',
    extra ?? '',
  ].filter(Boolean).join(' ');

  return (
    <button
      {...rest}
      ref={buttonRef}
      type={type}
      class={classes}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      aria-pressed={pressed === undefined ? rest['aria-pressed'] : pressed}
    >
      {loading ? <span class="bds-btn-spinner" aria-hidden="true" /> : icon != null ? <span class="bds-btn-icon" aria-hidden="true">{icon}</span> : null}
      {!iconOnly && <span class="bds-btn-label">{children}</span>}
    </button>
  );
}
