import type { ComponentChildren } from 'preact';
import { useId } from 'preact/hooks';
import { Toggle } from './Toggle';

interface SwitchRowProps {
  title: ComponentChildren;
  description?: ComponentChildren;
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
  /** The switch's accessible name when the title isn't plain text. */
  ariaLabel?: string;
  /** md (default) · lg (phones: 44px rows). */
  size?: 'md' | 'lg';
  class?: string;
}

// A setting that's on or off: title and description on the left, the
// switch on the right. Every switch-with-a-description row uses this.
export function SwitchRow({ title, description, checked, onChange, disabled, ariaLabel, size = 'md', class: extra }: SwitchRowProps) {
  const id = useId();
  const cls = ['bds-switch-row', `bds-switch-row-${size}`, disabled ? 'bds-switch-row-disabled' : '', extra ?? ''].filter(Boolean).join(' ');
  return (
    <div class={cls} onClick={(e) => {
      // A click on the text toggles too; the switch's own click is its own.
      if (disabled || (e.target as HTMLElement).closest('.bds-toggle')) return;
      onChange(!checked);
    }}>
      <span class="bds-switch-row-text">
        <span class="bds-switch-row-title" id={`${id}-t`}>{title}</span>
        {description && <span class="bds-switch-row-desc" id={`${id}-d`}>{description}</span>}
      </span>
      <Toggle
        checked={checked}
        onChange={onChange}
        disabled={disabled}
        ariaLabel={ariaLabel ?? (typeof title === 'string' ? title : undefined)}
        describedBy={description ? `${id}-d` : undefined}
      />
    </div>
  );
}
