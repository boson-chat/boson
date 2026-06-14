// Persisted widths for the resizable side panels (channel list, member list).
// Stored in localStorage and clamped to sane bounds so a saved value can't make
// a panel unusably small or eat the whole window.

const STORAGE_KEY = 'boson:panel-sizes:v1';

export type PanelKey = 'channels' | 'members';

export const PANEL_BOUNDS: Record<PanelKey, { min: number; max: number; def: number }> = {
  channels: { min: 180, max: 480, def: 240 },
  members: { min: 160, max: 420, def: 240 },
};

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

function readAll(): Record<string, number> {
  try {
    if (typeof localStorage === 'undefined') return {};
    return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') as Record<string, number>;
  } catch { return {}; }
}

export function getPanelWidth(key: PanelKey): number {
  const b = PANEL_BOUNDS[key];
  const v = readAll()[key];
  return typeof v === 'number' && Number.isFinite(v) ? clamp(v, b.min, b.max) : b.def;
}

// Persist a width (clamped) and return the value actually stored.
export function setPanelWidth(key: PanelKey, width: number): number {
  const b = PANEL_BOUNDS[key];
  const v = clamp(Math.round(width), b.min, b.max);
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...readAll(), [key]: v }));
    }
  } catch { /* best-effort */ }
  return v;
}
