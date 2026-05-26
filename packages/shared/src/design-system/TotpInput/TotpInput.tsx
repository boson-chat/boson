import { useRef } from 'preact/hooks';
import './TotpInput.css';

interface TotpInputProps {
  length?: number;
  value: string;
  onChange: (code: string) => void;
  autoFocus?: boolean;
}

export function TotpInput({ length = 6, value, onChange, autoFocus }: TotpInputProps) {
  const refs = useRef<Array<HTMLInputElement | null>>([]);

  const setChar = (idx: number, next: string) => {
    const sanitized = next.replace(/[^0-9a-zA-Z]/g, '').slice(-1);
    const arr = value.split('');
    while (arr.length <= idx) arr.push('');
    arr[idx] = sanitized;
    onChange(arr.join(''));
    if (sanitized && refs.current[idx + 1]) refs.current[idx + 1]?.focus();
  };

  const onKeyDown = (idx: number, e: KeyboardEvent) => {
    if (e.key === 'Backspace' && !value.charAt(idx) && refs.current[idx - 1]) {
      refs.current[idx - 1]?.focus();
    }
  };

  return (
    <div class="bds-totp">
      {Array.from({ length }).map((_, idx) => (
        <input
          key={idx}
          ref={(el) => { refs.current[idx] = el; }}
          type="text"
          inputMode="numeric"
          maxLength={1}
          class="bds-totp-input"
          value={value.charAt(idx)}
          autoFocus={autoFocus && idx === 0}
          onInput={(e) => setChar(idx, (e.target as HTMLInputElement).value)}
          onKeyDown={(e) => onKeyDown(idx, e)}
          aria-label={`Digit ${idx + 1}`}
        />
      ))}
    </div>
  );
}
