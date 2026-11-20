import type { ComponentChildren } from 'preact';
import { useRef } from 'preact/hooks';
import './Segmented.css';

export interface SegmentedOption<T extends string> {
  id: T;
  label: ComponentChildren;
  /** Spoken name when the label isn't text (an icon) or needs more. */
  ariaLabel?: string;
}

interface SegmentedProps<T extends string> {
  /** The group's accessible name ("Who can call me"). */
  label?: string;
  /** Or the id of a visible label. */
  labelledBy?: string;
  value: T;
  options: ReadonlyArray<SegmentedOption<T>>;
  onChange: (value: T) => void;
  /** md 34px (default) · lg 44px (phones). */
  size?: 'md' | 'lg';
  /** Options share the width (default) or size to their labels. */
  fill?: boolean;
  class?: string;
}

// One choice out of a few, side by side: a radio group drawn as joined
// buttons. Arrow keys move the choice, as in any radio group.
export function Segmented<T extends string>({ label, labelledBy, value, options, onChange, size = 'md', fill = true, class: extra }: SegmentedProps<T>) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const onKey = (e: KeyboardEvent, i: number): void => {
    const step = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
    if (!step) return;
    e.preventDefault();
    const next = (i + step + options.length) % options.length;
    onChange(options[next].id);
    refs.current[next]?.focus();
  };
  const cls = ['bds-seg', `bds-seg-${size}`, fill ? 'bds-seg-fill' : '', extra ?? ''].filter(Boolean).join(' ');
  return (
    <div class={cls} role="radiogroup" aria-label={labelledBy ? undefined : label} aria-labelledby={labelledBy}>
      {options.map((o, i) => {
        const on = o.id === value;
        return (
          <button
            key={o.id}
            ref={(el) => { refs.current[i] = el; }}
            type="button"
            role="radio"
            aria-checked={on}
            aria-label={o.ariaLabel}
            tabIndex={on ? 0 : -1}
            class={`bds-seg-opt${on ? ' bds-seg-on' : ''}`}
            onClick={() => onChange(o.id)}
            onKeyDown={(e) => onKey(e, i)}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
