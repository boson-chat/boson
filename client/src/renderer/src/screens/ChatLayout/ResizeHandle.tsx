import './ResizeHandle.css';

interface ResizeHandleProps {
  // Which side the resized panel is on, relative to this handle:
  //   'left'  → panel is to the LEFT (channel list); drag right to grow.
  //   'right' → panel is to the RIGHT (member list); drag left to grow.
  side: 'left' | 'right';
  width: number;
  min: number;
  max: number;
  onChange: (w: number) => void; // live, during drag
  onCommit: (w: number) => void; // on release (persist)
  onReset?: () => void;          // double-click to restore default
  ariaLabel: string;
}

// A thin draggable divider between two panels. Uses pointer capture on window so
// the drag keeps tracking even if the cursor outruns the 5px hit area.
export function ResizeHandle({ side, width, min, max, onChange, onCommit, onReset, ariaLabel }: ResizeHandleProps) {
  const onPointerDown = (e: PointerEvent): void => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = width;
    const compute = (clientX: number): number => {
      const dx = clientX - startX;
      const delta = side === 'left' ? dx : -dx;
      return Math.min(max, Math.max(min, startW + delta));
    };
    const move = (ev: PointerEvent): void => onChange(compute(ev.clientX));
    const up = (ev: PointerEvent): void => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      document.body.classList.remove('resizing-x');
      onCommit(compute(ev.clientX));
    };
    document.body.classList.add('resizing-x');
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  return (
    <div
      class="resize-handle"
      role="separator"
      aria-orientation="vertical"
      aria-label={ariaLabel}
      title="Drag to resize · double-click to reset"
      onPointerDown={onPointerDown}
      onDblClick={onReset}
    />
  );
}
