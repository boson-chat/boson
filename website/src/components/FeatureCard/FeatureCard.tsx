import type { ComponentChildren } from 'preact';
import './FeatureCard.css';

interface FeatureCardProps {
  icon: ComponentChildren;
  title: string;
  children: ComponentChildren;
}

/**
 * "Three decisions" / feature-row card. Square icon mark on top, h3, and a
 * short paragraph. Visually distinct from `Card` (no surface fill).
 */
export function FeatureCard({ icon, title, children }: FeatureCardProps) {
  return (
    <div class="feature">
      <div class="feature-mark" aria-hidden="true">
        {icon}
      </div>
      <h3>{title}</h3>
      <p>{children}</p>
    </div>
  );
}
