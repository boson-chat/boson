import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { createPortal } from 'preact/compat';
import { clamp, formatHex, hsvToHex, parseColor, parseHex, rgbToHsv, type Hsva } from './color';
import './ColorPicker.css';

// The theme editor's colour picker: a swatch that opens a popover with a
// saturation × brightness square, hue and opacity strips, a hex field, the
// theme's other colours to reuse, and (where the platform has one) an
// eyedropper. Every change goes straight to onChange, so the live preview
// follows the drag.

interface Props {
  // The token's current value: any CSS colour the editor accepts.
  value: string;
  onChange: (hex: string) => void;
  label: string;
  // The theme's other colours, offered as one-click swatches.
  swatches?: readonly string[];
}

type EyeDropperCtor = new () => { open(): Promise<{ sRGBHex: string }> };
const eyeDropper = (): EyeDropperCtor | undefined => (globalThis as { EyeDropper?: EyeDropperCtor }).EyeDropper;

const fromValue = (value: string): Hsva => rgbToHsv(parseColor(value) ?? { r: 0, g: 0, b: 0, a: 1 });

export function ColorPicker({ value, onChange, label, swatches = [] }: Props) {
  const [open, setOpen] = useState(false);
  const [hsv, setHsv] = useState<Hsva>(() => fromValue(value));
  const [hexText, setHexText] = useState(() => hsvToHex(fromValue(value)));
  // The last colour we sent, so the value echoing back doesn't reset HSV
  // (hue is lost at zero saturation, and rounding would make the thumb jump).
  const sent = useRef<string | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const area = useRef<HTMLDivElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  // Where the popover sits, in viewport coordinates: it's rendered into
  // <body> with position: fixed so the settings dialog (scroll area, and a
  // transform that would re-anchor `fixed`) can't clip or move it. Below the
  // swatch or, without room there, above it.
  const [place, setPlace] = useState<{ left: number; top: number } | null>(null);

  useEffect(() => {
    if (value === sent.current) return;
    const next = fromValue(value);
    setHsv(next);
    setHexText(hsvToHex(next));
  }, [value]);

  useLayoutEffect(() => {
    if (!open) { setPlace(null); return; }
    const position = (): void => {
      const b = button.current?.getBoundingClientRect();
      const p = pop.current;
      if (!b || !p) return;
      const gap = 6, margin = 8;
      const w = p.offsetWidth, h = p.offsetHeight;
      const below = b.bottom + gap;
      const top = below + h + margin <= window.innerHeight ? below : Math.max(margin, b.top - gap - h);
      const left = Math.min(Math.max(margin, b.left), window.innerWidth - w - margin);
      setPlace({ left, top });
    };
    position();
    window.addEventListener('resize', position);
    window.addEventListener('scroll', position, true); // any scroll container
    return () => {
      window.removeEventListener('resize', position);
      window.removeEventListener('scroll', position, true);
    };
  }, [open]);

  // Close on a click outside or Escape; give focus back to the swatch.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent): void => {
      const t = e.target as Node;
      if (!root.current?.contains(t) && !pop.current?.contains(t)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return;
      e.stopPropagation(); // don't also close the settings dialog
      setOpen(false);
      button.current?.focus();
    };
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('pointerdown', onDown, true);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [open]);

  const commit = (next: Hsva): void => {
    setHsv(next);
    const hex = hsvToHex(next);
    setHexText(hex);
    sent.current = hex;
    onChange(hex);
  };

  const pickFromArea = (e: PointerEvent): void => {
    const box = area.current?.getBoundingClientRect();
    if (!box || box.width === 0 || box.height === 0) return;
    commit({
      ...hsv,
      s: clamp((e.clientX - box.left) / box.width, 0, 1),
      v: clamp(1 - (e.clientY - box.top) / box.height, 0, 1),
    });
  };

  const onAreaKey = (e: KeyboardEvent): void => {
    const step = e.shiftKey ? 0.1 : 0.01;
    const d: Record<string, [number, number]> = {
      ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, step], ArrowDown: [0, -step],
    };
    const delta = d[e.key];
    if (!delta) return;
    e.preventDefault();
    commit({ ...hsv, s: clamp(hsv.s + delta[0], 0, 1), v: clamp(hsv.v + delta[1], 0, 1) });
  };

  const setHex = (text: string): void => {
    setHexText(text);
    const t = text.trim();
    const rgba = parseHex(t.startsWith('#') ? t : `#${t}`);
    if (!rgba) return;
    const hex = formatHex(rgba);
    setHsv(rgbToHsv(rgba));
    sent.current = hex;
    onChange(hex);
  };

  const pickSwatch = (c: string): void => {
    const rgba = parseColor(c);
    if (!rgba) return;
    const next = rgbToHsv(rgba);
    setHsv(next);
    const hex = formatHex(rgba);
    setHexText(hex);
    sent.current = hex;
    onChange(hex);
  };

  const dropper = eyeDropper();
  const sample = async (): Promise<void> => {
    if (!dropper) return;
    try {
      const { sRGBHex } = await new dropper().open();
      pickSwatch(sRGBHex);
    } catch { /* cancelled */ }
  };

  const opaque = hsvToHex({ ...hsv, a: 1 });
  const pct = (n: number): string => `${Math.round(n * 100)}%`;
  const uniqueSwatches = [...new Set(swatches.map((s) => s.trim().toLowerCase()))];

  return (
    <div class="color-picker" ref={root}>
      <button
        ref={button}
        type="button"
        class="color-picker-swatch"
        aria-label={`${label} colour picker`}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <span style={{ background: value }} />
      </button>
      {open && createPortal(
        <div
          ref={pop}
          class="color-picker-pop"
          role="dialog"
          aria-label={`Pick ${label}`}
          style={place ? { left: `${place.left}px`, top: `${place.top}px` } : { visibility: 'hidden' }}
        >
          <div
            ref={area}
            class="color-picker-area"
            style={{ background: `hsl(${hsv.h} 100% 50%)` }}
            onPointerDown={(e) => {
              (e.currentTarget as HTMLDivElement).setPointerCapture?.(e.pointerId);
              pickFromArea(e);
            }}
            onPointerMove={(e) => { if (e.buttons & 1) pickFromArea(e); }}
          >
            <span
              class="color-picker-area-thumb"
              role="slider"
              tabIndex={0}
              aria-label="Saturation and brightness"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(hsv.s * 100)}
              aria-valuetext={`Saturation ${pct(hsv.s)}, brightness ${pct(hsv.v)}`}
              style={{ left: pct(hsv.s), top: pct(1 - hsv.v), background: opaque }}
              onKeyDown={onAreaKey}
            />
          </div>

          <input
            type="range"
            class="color-picker-strip color-picker-hue"
            aria-label="Hue"
            min={0}
            max={360}
            value={Math.round(hsv.h)}
            onInput={(e) => commit({ ...hsv, h: Number(e.currentTarget.value) })}
          />
          <input
            type="range"
            class="color-picker-strip color-picker-alpha"
            aria-label="Opacity"
            min={0}
            max={100}
            value={Math.round(hsv.a * 100)}
            style={{ '--cp-color': opaque } as Record<string, string>}
            onInput={(e) => commit({ ...hsv, a: Number(e.currentTarget.value) / 100 })}
          />

          <div class="color-picker-row">
            <span class="color-picker-preview" aria-hidden="true">
              <span style={{ background: hsvToHex(hsv) }} />
            </span>
            <input
              class="color-picker-hex"
              aria-label="Hex"
              value={hexText}
              spellcheck={false}
              maxLength={9}
              onInput={(e) => setHex(e.currentTarget.value)}
              onBlur={() => setHexText(hsvToHex(hsv))}
            />
            {dropper && (
              <button type="button" class="color-picker-dropper" aria-label="Pick a colour from the screen" onClick={() => void sample()}>
                <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
                  <path d="M11.5 1.5a2 2 0 0 1 2.9 2.8l-1.6 1.6.7.7-1 1-.7-.7-5.6 5.6H3.3v-2.9l5.6-5.6-.7-.7 1-1 .7.7z" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round" />
                </svg>
              </button>
            )}
          </div>

          {uniqueSwatches.length > 0 && (
            <div class="color-picker-swatches" role="group" aria-label="Theme colours">
              {uniqueSwatches.map((c) => (
                <button
                  key={c}
                  type="button"
                  class="color-picker-chip"
                  title={c}
                  aria-label={`Use ${c}`}
                  style={{ background: c }}
                  onClick={() => pickSwatch(c)}
                />
              ))}
            </div>
          )}
        </div>,
        document.body,
      )}
    </div>
  );
}
