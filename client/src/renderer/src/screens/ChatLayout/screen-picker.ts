import type { VideoSource } from '../../modules/video';

// The screen share picker's logic (ScreenPicker.tsx): the remembered
// choice, the first selection, and moving the selection with the keys.

export type PickerTab = 'screens' | 'windows';
export type ShareMode = 'detail' | 'motion';

const KEY = 'boson.screenShare';

/** What was shared last: the display, or the app (its windows come and
 * go), and the mode. */
export interface RememberedShare {
  kind: 'display' | 'window';
  id: string;
  app?: string;
  mode: ShareMode;
}

export function rememberShare(src: VideoSource, mode: ShareMode): void {
  const r: RememberedShare = { kind: src.kind === 'window' ? 'window' : 'display', id: src.id, app: src.app, mode };
  try {
    localStorage.setItem(KEY, JSON.stringify(r));
  } catch {
    // no storage: nothing remembered
  }
}

export function rememberedShare(): RememberedShare | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const r = JSON.parse(raw) as RememberedShare;
    return r && (r.kind === 'display' || r.kind === 'window') && typeof r.id === 'string' ? r : null;
  } catch {
    return null;
  }
}

/** Where the picker starts: what's being shared now; else the remembered
 * display or a window of the remembered app; else the main display. */
export function initialPick(sources: readonly VideoSource[], current: string | null, remembered: RememberedShare | null): { tab: PickerTab; id: string | null } {
  const tabOf = (s: VideoSource): PickerTab => (s.kind === 'window' ? 'windows' : 'screens');
  const byId = (id: string) => sources.find((s) => s.id === id);
  const now = current ? byId(current) : undefined;
  if (now) return { tab: tabOf(now), id: now.id };
  if (remembered) {
    const same = byId(remembered.id) ?? (remembered.kind === 'window' && remembered.app ? sources.find((s) => s.kind === 'window' && s.app === remembered.app) : undefined);
    if (same) return { tab: tabOf(same), id: same.id };
  }
  const main = sources.find((s) => s.kind === 'display' && s.main) ?? sources.find((s) => s.kind === 'display') ?? sources[0];
  return { tab: main ? tabOf(main) : 'screens', id: main?.id ?? null };
}

/** The sources on a tab; windows narrowed by the search (app or title). */
export function sourcesFor(sources: readonly VideoSource[], tab: PickerTab, search = ''): VideoSource[] {
  const list = sources.filter((s) => (tab === 'windows' ? s.kind === 'window' : s.kind === 'display'));
  const q = search.trim().toLowerCase();
  if (tab !== 'windows' || !q) return list;
  return list.filter((s) => `${s.app ?? ''} ${s.title ?? ''} ${s.name}`.toLowerCase().includes(q));
}

/** The selection after a key in a grid of `cols` columns, or null for a key
 * that doesn't move it. */
export function moveSelection(index: number, count: number, cols: number, key: string): number | null {
  if (count === 0) return null;
  const i = Math.max(0, index);
  switch (key) {
    case 'ArrowRight': return Math.min(count - 1, i + 1);
    case 'ArrowLeft': return Math.max(0, i - 1);
    case 'ArrowDown': return Math.min(count - 1, i + cols);
    case 'ArrowUp': return Math.max(0, i - cols);
    case 'Home': return 0;
    case 'End': return count - 1;
    default: return null;
  }
}
