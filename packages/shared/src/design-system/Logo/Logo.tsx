import './Logo.css';

interface LogoProps {
  mark?: string;
  tagline?: string;
  markAs?: 'h1' | 'h2' | 'div';
}

export function Logo({ mark = 'Boson', tagline = 'IRC, modernized', markAs = 'h1' }: LogoProps) {
  const Heading = markAs;
  return (
    <div class="bds-logo">
      <Heading class="bds-logo-mark">{mark}</Heading>
      <div class="bds-logo-tagline">{tagline}</div>
    </div>
  );
}
