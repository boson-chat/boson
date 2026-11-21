import './Toggle.css';

interface ToggleProps {
  checked: boolean;
  onChange: (next: boolean) => void;
  label?: string;
  // The switch's accessible name when there's no visible label.
  ariaLabel?: string;
  disabled?: boolean;
  /** Id of text that says more about it (a SwitchRow's description). */
  describedBy?: string;
  /** 'switch': announce it as a switch (role="switch", aria-checked) instead of a checkbox. */
  role?: 'switch';
}

export function Toggle({ checked, onChange, label, ariaLabel, disabled, describedBy, role }: ToggleProps) {
  return (
    <label class={`bds-toggle ${disabled ? 'bds-toggle-disabled' : ''}`}>
      <input
        type="checkbox"
        class="bds-toggle-input"
        role={role}
        aria-checked={role === 'switch' ? checked : undefined}
        aria-label={label ? undefined : ariaLabel}
        aria-describedby={describedBy}
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange((e.target as HTMLInputElement).checked)}
      />
      <span class="bds-toggle-track" aria-hidden="true">
        <span class="bds-toggle-thumb" />
      </span>
      {label && <span class="bds-toggle-label">{label}</span>}
    </label>
  );
}
