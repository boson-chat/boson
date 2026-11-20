import type { ComponentChildren } from 'preact';
import { createPortal } from 'preact/compat';
import { Sheet, type SheetAction } from '@boson/shared';

export type { SheetAction };

interface BottomSheetProps {
  /** Accessible name for the dialog. */
  label: string;
  /** Top of the sheet; drags the sheet even when its body scrolls. */
  header: ComponentChildren;
  /** Between the header and the actions. */
  children?: ComponentChildren;
  actions: readonly SheetAction[];
  onClose: () => void;
}

// The phone layout's menu: the design system's Sheet (slides up, swipes
// away), portalled to <body> so no ancestor clips or transforms it. The
// shared package can't portal itself (no preact/compat there).
export function BottomSheet(props: BottomSheetProps) {
  return createPortal(<Sheet {...props} />, document.body);
}
