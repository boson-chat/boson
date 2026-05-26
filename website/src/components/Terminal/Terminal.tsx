import type { ComponentChildren } from 'preact';

interface TerminalProps {
  ariaLabel?: string;
  children: ComponentChildren;
}

/**
 * A code/terminal "block" — relies on the global `.code` classes from
 * `styles.css`. Use the helper `<Line>` component for individual lines and
 * the `<C>` helper for token-colored spans (cmt / key / str / fn / acc / ok).
 */
export function Terminal({ ariaLabel, children }: TerminalProps) {
  return (
    <div class="code" role={ariaLabel ? 'img' : undefined} aria-label={ariaLabel}>
      {children}
    </div>
  );
}

interface LineProps {
  children?: ComponentChildren;
  prompt?: boolean;
}

export function Line({ children, prompt }: LineProps) {
  return <div class={`terminal-line${prompt ? ' prompt' : ''}`}>{children ?? ' '}</div>;
}

type Tone = 'cmt' | 'key' | 'str' | 'fn' | 'acc' | 'ok';

interface CProps {
  tone: Tone;
  children: ComponentChildren;
}

export function C({ tone, children }: CProps) {
  return <span class={`c-${tone}`}>{children}</span>;
}
