import type { JSX } from 'preact';
import { useRef, useState } from 'preact/hooks';
import './ChipInput.css';

interface ChipInputProps {
  /** Current set of chips. Treated as ordered + de-duplicated. */
  value: readonly string[];
  /** Fired with the new chip list whenever the user adds or removes one. */
  onChange: (next: string[]) => void;
  /** Placeholder shown only when no chips are present. */
  placeholder?: string;
  /** Lower-cases incoming values (default true). Useful for tags/languages. */
  lowercase?: boolean;
  /** Strip leading "#" so users typing #foss get the chip "foss". */
  stripHash?: boolean;
  /** Allowed-chars regex; values failing it are silently rejected. */
  pattern?: RegExp;
  /** Maximum chips. Excess paste-in tokens are truncated. */
  max?: number;
  /** Disabled state. Renders chips but blocks add + remove. */
  disabled?: boolean;
  /** Accessible label for the underlying input. */
  ariaLabel?: string;
}

/**
 * Multi-value chip input. Commits on Enter / comma / blur; deletes
 * the last chip on Backspace when the buffer is empty (the natural
 * "oops, I want to edit that one" path). Pasting a comma-separated
 * list explodes it into one chip per token in a single keystroke,
 * which is how most users paste tag lists out of docs / spreadsheets.
 *
 * Used today for the Tags and Languages fields in the directory
 * registration + edit flows. The component is intentionally
 * value-only — no autocomplete, no async suggestion fetching — so it
 * stays embeddable anywhere without prop drilling.
 */
export function ChipInput({
  value,
  onChange,
  placeholder,
  lowercase = true,
  stripHash = false,
  pattern,
  max,
  disabled = false,
  ariaLabel,
}: ChipInputProps) {
  const [buffer, setBuffer] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  const commit = (raw: string): void => {
    // Split on comma so a single keystroke can add many chips when the
    // user pastes a CSV. Reduce to unique, normalised entries.
    const incoming = raw
      .split(',')
      .map((s) => normalise(s, { lowercase, stripHash, pattern }))
      .filter(Boolean) as string[];

    // ALWAYS clear the buffer once the user has tried to commit —
    // even when validation rejects every token. Leaving the rejected
    // value in the buffer makes subsequent typing chain onto the
    // failed input ("english" + "en" → "englishen") which is the
    // worse failure mode.
    setBuffer('');
    if (incoming.length === 0) return;

    const set = new Set(value);
    const next = [...value];
    for (const v of incoming) {
      if (set.has(v)) continue;
      if (max && next.length >= max) break;
      set.add(v);
      next.push(v);
    }
    if (next.length !== value.length) onChange(next);
  };

  const removeAt = (index: number): void => {
    if (disabled) return;
    const next = value.slice();
    next.splice(index, 1);
    onChange(next);
  };

  const onKeyDown = (event: JSX.TargetedKeyboardEvent<HTMLInputElement>): void => {
    if (disabled) return;
    if (event.key === 'Enter' || event.key === ',') {
      // Commit + suppress the literal comma / form-submit from leaking
      // into the surrounding form.
      event.preventDefault();
      commit(buffer);
      return;
    }
    if (event.key === 'Backspace' && buffer === '' && value.length > 0) {
      // Inline "edit the last chip" affordance — drop the latest chip
      // back into the buffer instead of just deleting it, so a typo
      // can be fixed without re-typing.
      event.preventDefault();
      const last = value[value.length - 1];
      onChange(value.slice(0, -1));
      setBuffer(last);
    }
  };

  const onBlur = (): void => {
    if (buffer.trim()) commit(buffer);
  };

  return (
    <div
      class={`bds-chip-input${disabled ? ' bds-chip-input-disabled' : ''}`}
      onClick={() => inputRef.current?.focus()}
    >
      {value.map((chip, idx) => (
        <span class="bds-chip" key={chip}>
          <span class="bds-chip-text">{chip}</span>
          <button
            type="button"
            class="bds-chip-remove"
            aria-label={`Remove ${chip}`}
            tabIndex={-1}
            disabled={disabled}
            onClick={(e) => {
              e.stopPropagation();
              removeAt(idx);
            }}
          >
            ×
          </button>
        </span>
      ))}
      <input
        ref={inputRef}
        type="text"
        class="bds-chip-input-field"
        value={buffer}
        placeholder={value.length === 0 ? placeholder : undefined}
        aria-label={ariaLabel}
        disabled={disabled}
        onInput={(e) => setBuffer((e.target as HTMLInputElement).value)}
        onKeyDown={onKeyDown}
        onBlur={onBlur}
        autoComplete="off"
        spellcheck={false}
      />
    </div>
  );
}

interface NormaliseOptions {
  lowercase: boolean;
  stripHash: boolean;
  pattern?: RegExp;
}

function normalise(raw: string, opts: NormaliseOptions): string | null {
  let v = raw.trim();
  if (!v) return null;
  if (opts.stripHash && v.startsWith('#')) v = v.slice(1);
  if (opts.lowercase) v = v.toLowerCase();
  if (opts.pattern && !opts.pattern.test(v)) return null;
  return v;
}
