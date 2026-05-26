interface BosonGlyphProps {
  size?: number;
  class?: string;
}

/**
 * The orbital-electron mark used in the marketing header & footer logos.
 * Pure SVG so it inherits color from `currentColor` and scales freely.
 */
export function BosonGlyph({ size = 18, class: className }: BosonGlyphProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
      class={className}
    >
      <circle cx="12" cy="12" r="2" fill="currentColor" />
      <ellipse cx="12" cy="12" rx="10" ry="4" />
      <ellipse cx="12" cy="12" rx="10" ry="4" transform="rotate(60 12 12)" />
      <ellipse cx="12" cy="12" rx="10" ry="4" transform="rotate(120 12 12)" />
    </svg>
  );
}
