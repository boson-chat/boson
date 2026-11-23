import { render, type ComponentChildren } from 'preact';
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { NARROW_QUERY } from '../../hooks/narrow';
import { Sheet } from '../Sheet/Sheet';
import '../Menu/Menu.css';
import './Select.css';

export interface SelectOption<T extends string> {
  value: T;
  label: string;
  /** A second line under the label (what the choice means). */
  description?: string;
  disabled?: boolean;
}

export interface SelectProps<T extends string> {
  value: T;
  options: ReadonlyArray<SelectOption<T>>;
  /** Only called when the choice changes. */
  onChange: (value: T) => void;
  /** Accessible name ("Role", "Input device"). */
  label?: string;
  /** Or the id of a visible label. */
  labelledBy?: string;
  /** The trigger's id. */
  id?: string;
  /** sm and md are the bds-input sizes. */
  size?: 'sm' | 'md';
  disabled?: boolean;
  /** Shown when `value` isn't one of the options. */
  placeholder?: string;
  /** Extra classes on the trigger (layout: width, min-height). */
  class?: string;
  /**
   * How the list opens: a popover under the trigger, or a bottom Sheet (the
   * phone layout's menu). Default: a Sheet below the phone breakpoint.
   */
  presentation?: 'auto' | 'popover' | 'sheet';
}

// Gap between the trigger and the list, and the list and the viewport edge.
const GAP = 4;
const EDGE = 8;
// The list's tallest; it scrolls past this.
const MAX_LIST = 320;
// Type-ahead: keys typed within this many ms are one search.
const TYPEAHEAD_MS = 500;

function isNarrowViewport(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    && window.matchMedia(NARROW_QUERY).matches;
}

// One choice out of a list: the app's only dropdown (never a native
// <select>, which can't take the theme and looks different on every
// platform). A button that looks like an Input opens a listbox built from
// the Menu's surface and items: a popover on desktop, a Sheet on phones.
// The list is rendered into <body>, so a Modal's or Sheet's overflow and
// transform can't clip or shift it.
export function Select<T extends string>({
  value, options, onChange, label, labelledBy, id, size = 'md', disabled, placeholder, class: extra, presentation = 'auto',
}: SelectProps<T>) {
  const uid = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState<false | 'popover' | 'sheet'>(false);
  const [initial, setInitial] = useState(-1);
  const current = options.find((o) => o.value === value);
  const labelId = `${uid}-label`;
  const valueId = `${uid}-value`;
  const listId = `${uid}-list`;

  const show = (from?: number): void => {
    if (disabled) return;
    const sheet = presentation === 'sheet' || (presentation === 'auto' && isNarrowViewport());
    setInitial(from ?? options.findIndex((o) => o.value === value));
    setOpen(sheet ? 'sheet' : 'popover');
  };
  const hide = (): void => {
    setOpen(false);
    triggerRef.current?.focus();
  };
  const pick = (v: T): void => {
    if (v !== value) onChange(v);
  };

  const onTriggerKey = (e: KeyboardEvent): void => {
    if (open) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      show();
    } else if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault();
      show(e.key === 'Home' ? firstEnabled(options, 0, 1) : firstEnabled(options, options.length - 1, -1));
    } else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      const at = options.findIndex((o) => o.value === value);
      const hit = matchFrom(options, at + 1, e.key.toLowerCase());
      if (hit >= 0) { e.preventDefault(); show(hit); }
    }
  };

  const cls = ['bds-input', `bds-input-${size}`, 'bds-select', open ? 'bds-select-open' : '', extra ?? ''].filter(Boolean).join(' ');
  return (
    <button
      ref={triggerRef}
      type="button"
      id={id}
      class={cls}
      disabled={disabled}
      aria-haspopup="listbox"
      aria-expanded={open ? 'true' : 'false'}
      aria-controls={open ? listId : undefined}
      aria-labelledby={`${labelledBy ?? (label != null ? labelId : '')} ${valueId}`.trim()}
      onClick={() => (open ? hide() : show())}
      onKeyDown={onTriggerKey}
    >
      {label != null && !labelledBy && <span id={labelId} hidden>{label}</span>}
      <span id={valueId} class={`bds-select-value${current ? '' : ' bds-select-placeholder'}`}>{current?.label ?? placeholder ?? ''}</span>
      <svg class="bds-select-chevron" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
        <path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="square" />
      </svg>
      {open && (
        <Layer>
          <SelectList
            mode={open}
            listId={listId}
            label={label ?? (labelledBy ? document.getElementById(labelledBy)?.textContent ?? '' : '')}
            options={options}
            value={value}
            initial={initial}
            trigger={triggerRef}
            onPick={(v) => { pick(v); }}
            onClose={hide}
          />
        </Layer>
      )}
    </button>
  );
}

function firstEnabled<T extends string>(options: ReadonlyArray<SelectOption<T>>, from: number, step: 1 | -1): number {
  for (let i = from; i >= 0 && i < options.length; i += step) if (!options[i]!.disabled) return i;
  return -1;
}

// The next enabled option, from `from` (wrapping), whose label starts with `q`.
function matchFrom<T extends string>(options: ReadonlyArray<SelectOption<T>>, from: number, q: string): number {
  const n = options.length;
  for (let k = 0; k < n; k++) {
    const i = (from + k) % n;
    const o = options[i]!;
    if (!o.disabled && o.label.toLowerCase().startsWith(q)) return i;
  }
  return -1;
}

// Renders its children into a <div> at the end of <body> (above Modals and
// Sheets). The shared package has no preact/compat, so no createPortal: a
// second render root does the same for a list that needs no context.
function Layer({ children }: { children: ComponentChildren }) {
  const host = useRef<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    const el = document.createElement('div');
    el.className = 'bds-select-layer';
    document.body.appendChild(el);
    host.current = el;
    return () => {
      render(null, el);
      el.remove();
      host.current = null;
    };
  }, []);
  useLayoutEffect(() => {
    if (host.current) render(<>{children}</>, host.current);
  });
  return null;
}

interface ListProps<T extends string> {
  mode: 'popover' | 'sheet';
  listId: string;
  label: string;
  options: ReadonlyArray<SelectOption<T>>;
  value: T;
  initial: number;
  trigger: { current: HTMLButtonElement | null };
  onPick: (v: T) => void;
  onClose: () => void;
}

function SelectList<T extends string>({ mode, listId, label, options, value, initial, trigger, onPick, onClose }: ListProps<T>) {
  const listRef = useRef<HTMLDivElement>(null);
  const sheetClose = useRef<(() => void) | null>(null);
  const [active, setActive] = useState(() => (initial >= 0 && !options[initial]?.disabled ? initial : firstEnabled(options, 0, 1)));
  const typed = useRef({ q: '', at: 0 });
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const optId = (i: number): string => `${listId}-${i}`;

  // Close: a Sheet slides away first; a popover just goes.
  const dismiss = (): void => {
    if (mode === 'sheet' && sheetClose.current) sheetClose.current();
    else onClose();
  };
  const choose = (i: number): void => {
    const o = options[i];
    if (!o || o.disabled) return;
    onPick(o.value);
    dismiss();
  };

  useLayoutEffect(() => { listRef.current?.focus({ preventScroll: true }); }, []);
  useLayoutEffect(() => {
    if (active >= 0) listRef.current?.querySelector(`#${CSS.escape(optId(active))}`)?.scrollIntoView?.({ block: 'nearest' });
  }, [active]);

  // Popover: sit under the trigger, or above it when there's more room
  // there; never past the viewport's edges. Follows scrolls and resizes.
  useLayoutEffect(() => {
    if (mode !== 'popover') return;
    const place = (): void => {
      const el = listRef.current;
      const t = trigger.current;
      if (!el || !t) return;
      const r = t.getBoundingClientRect();
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      el.style.minWidth = `${Math.min(r.width, vw - 2 * EDGE)}px`;
      el.style.maxHeight = '';
      const natural = Math.min(el.scrollHeight, MAX_LIST);
      const below = vh - r.bottom - GAP - EDGE;
      const above = r.top - GAP - EDGE;
      const up = natural > below && above > below;
      const h = Math.max(0, Math.min(natural, up ? above : below));
      el.style.maxHeight = `${h}px`;
      el.style.top = `${up ? r.top - GAP - h : r.bottom + GAP}px`;
      const w = el.offsetWidth;
      el.style.left = `${Math.max(EDGE, Math.min(r.left, vw - EDGE - w))}px`;
      el.classList.toggle('bds-select-up', up);
    };
    place();
    const onScroll = (e: Event): void => {
      if (e.target instanceof Node && listRef.current?.contains(e.target)) return;
      place();
    };
    window.addEventListener('resize', place);
    window.addEventListener('scroll', onScroll, true);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', onScroll, true);
    };
  }, [mode]);

  // Popover: a press anywhere else closes it (the trigger toggles itself).
  useEffect(() => {
    if (mode !== 'popover') return;
    const onDown = (e: Event): void => {
      const n = e.target instanceof Node ? e.target : null;
      if (n && (listRef.current?.contains(n) || trigger.current?.contains(n))) return;
      closeRef.current();
    };
    document.addEventListener('pointerdown', onDown, true);
    return () => document.removeEventListener('pointerdown', onDown, true);
  }, [mode]);

  const move = (from: number, step: 1 | -1): void => {
    const next = firstEnabled(options, from, step);
    if (next >= 0) setActive(next);
  };

  const onKey = (e: KeyboardEvent): void => {
    // The list handles its keys; a Modal or Sheet underneath mustn't also
    // close on this Escape.
    e.stopPropagation();
    switch (e.key) {
      case 'ArrowDown': e.preventDefault(); move(active + 1, 1); return;
      case 'ArrowUp': e.preventDefault(); move(active - 1, -1); return;
      case 'Home': case 'PageUp': e.preventDefault(); move(0, 1); return;
      case 'End': case 'PageDown': e.preventDefault(); move(options.length - 1, -1); return;
      case 'Enter': case ' ':
        if (e.key === ' ' && typed.current.q && Date.now() - typed.current.at < TYPEAHEAD_MS) break;
        e.preventDefault(); choose(active); return;
      case 'Escape': e.preventDefault(); dismiss(); return;
      case 'Tab': e.preventDefault(); dismiss(); return;
    }
    if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      const t = typed.current;
      const now = Date.now();
      t.q = (now - t.at > TYPEAHEAD_MS ? '' : t.q) + e.key.toLowerCase();
      t.at = now;
      // One key again and again cycles through its matches; a word stays put while it still matches.
      const single = t.q.length > 1 && [...t.q].every((c) => c === t.q[0]);
      const hit = single || t.q.length === 1 ? matchFrom(options, active + 1, t.q[0]!) : matchFrom(options, Math.max(active, 0), t.q);
      if (hit >= 0) setActive(hit);
    }
  };

  const list = (
    <div
      ref={listRef}
      id={listId}
      class={mode === 'popover' ? 'bds-menu bds-select-list' : 'bds-select-sheet-list'}
      role="listbox"
      aria-label={label || undefined}
      tabIndex={-1}
      aria-activedescendant={active >= 0 ? optId(active) : undefined}
      onKeyDown={onKey}
    >
      {options.map((o, i) => {
        const selected = o.value === value;
        const cls = ['bds-menu-item', `bds-menu-item-${mode === 'sheet' ? 'lg' : 'md'}`, 'bds-select-option',
          i === active ? 'bds-select-active' : '', o.description ? 'bds-select-option-desc' : ''].filter(Boolean).join(' ');
        return (
          <div
            key={o.value}
            id={optId(i)}
            class={cls}
            role="option"
            aria-selected={selected ? 'true' : 'false'}
            aria-disabled={o.disabled ? 'true' : undefined}
            data-value={o.value}
            onPointerMove={() => { if (!o.disabled && i !== active) setActive(i); }}
            onClick={() => choose(i)}
          >
            <span class="bds-menu-check" aria-hidden="true">{selected ? '✓' : ''}</span>
            <span class="bds-select-option-text">
              <span class="bds-menu-text">{o.label}</span>
              {o.description && <span class="bds-select-option-description">{o.description}</span>}
            </span>
          </div>
        );
      })}
    </div>
  );

  if (mode === 'popover') return list;
  return (
    <Sheet label={label || 'Choose'} header={label ? <div class="bds-select-sheet-title">{label}</div> : null}
      actions={[]} onClose={onClose} closeRef={sheetClose}>
      {list}
    </Sheet>
  );
}
