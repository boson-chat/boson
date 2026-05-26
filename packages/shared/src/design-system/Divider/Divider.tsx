import './Divider.css';

interface DividerProps {
  label?: string;
}

export function Divider({ label }: DividerProps) {
  if (label) {
    return (
      <div class="bds-divider bds-divider-labeled">
        <span class="bds-divider-label">{label}</span>
      </div>
    );
  }
  return <div class="bds-divider" role="separator" />;
}
