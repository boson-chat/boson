import './Toggle.css';

interface ToggleProps {
  checked: boolean;
  onChange: (next: boolean) => void;
  label?: string;
  disabled?: boolean;
}

export function Toggle({ checked, onChange, label, disabled }: ToggleProps) {
  return (
    <label class={`bds-toggle ${disabled ? 'bds-toggle-disabled' : ''}`}>
      <input
        type="checkbox"
        class="bds-toggle-input"
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
