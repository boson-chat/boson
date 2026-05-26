import type { ComponentChildren } from 'preact';
import './StepList.css';

interface StepProps {
  index: string;
  title: string;
  children: ComponentChildren;
}

/**
 * "How it works" three-step horizontal layout from the index hero.
 * Each step is bordered top, with a numeric label inset above.
 */
export function Step({ index, title, children }: StepProps) {
  return (
    <div class="step">
      <span class="step-num">{index}</span>
      <h3>{title}</h3>
      <p>{children}</p>
    </div>
  );
}

interface StepsProps {
  children: ComponentChildren;
}

export function Steps({ children }: StepsProps) {
  return <div class="steps">{children}</div>;
}
