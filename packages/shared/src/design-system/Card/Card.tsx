import type { ComponentChildren } from 'preact';
import './Card.css';

interface CardProps {
  variant?: 'flat' | 'raised';
  children?: ComponentChildren;
}

export function Card({ variant = 'flat', children }: CardProps) {
  return <div class={`bds-card bds-card-${variant}`}>{children}</div>;
}
