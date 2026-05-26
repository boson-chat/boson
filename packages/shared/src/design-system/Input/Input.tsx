import type { JSX } from 'preact';
import './Input.css';

type NativeInputProps = Omit<JSX.InputHTMLAttributes<HTMLInputElement>, 'class' | 'className' | 'size'>;

interface InputProps extends NativeInputProps {
  invalid?: boolean;
  inputSize?: 'sm' | 'md';
}

export function Input({ invalid = false, inputSize = 'md', ...rest }: InputProps) {
  const classes = [
    'bds-input',
    `bds-input-${inputSize}`,
    invalid ? 'bds-input-invalid' : '',
  ].filter(Boolean).join(' ');
  return <input {...rest} class={classes} aria-invalid={invalid || undefined} />;
}
