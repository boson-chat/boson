// Voice preferences, kept locally (localStorage) and pushed to the desktop
// app's voice service at start and on every change.

const STORAGE_KEY = 'boson:voice:v1';

export interface VoiceSettings {
  // Device ids; '' is the system default.
  inputId: string;
  outputId: string;
  // Voice activity or push to talk.
  mode: 'vad' | 'ptt';
  // KeyboardEvent.code of the push-to-talk key; null until one is chosen.
  pttCode: string | null;
  // Voice activity threshold, dBFS (-60 … -10).
  vadDb: number;
  // Per-user playback volume (by account id), percent 0…200.
  userVolumes: Record<string, number>;
}

export const VAD_MIN_DB = -60;
export const VAD_MAX_DB = -10;

export const DEFAULT_VOICE_SETTINGS: VoiceSettings = {
  inputId: '',
  outputId: '',
  mode: 'vad',
  pttCode: null,
  vadDb: -45,
  userVolumes: {},
};

interface KV {
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
}

function storage(): KV | null {
  try {
    return (globalThis as { localStorage?: KV }).localStorage ?? null;
  } catch {
    return null;
  }
}

let cached: VoiceSettings | null = null;
const listeners = new Set<(s: VoiceSettings) => void>();

export function getVoiceSettings(): VoiceSettings {
  if (cached) return cached;
  let next = { ...DEFAULT_VOICE_SETTINGS, userVolumes: {} };
  try {
    const raw = storage()?.getItem(STORAGE_KEY);
    if (raw) {
      const p = JSON.parse(raw) as Partial<VoiceSettings>;
      const volumes: Record<string, number> = {};
      if (p.userVolumes && typeof p.userVolumes === 'object') {
        for (const [k, v] of Object.entries(p.userVolumes)) {
          if (typeof v === 'number' && Number.isFinite(v)) volumes[k] = clamp(Math.round(v), 0, 200);
        }
      }
      next = {
        inputId: typeof p.inputId === 'string' ? p.inputId : next.inputId,
        outputId: typeof p.outputId === 'string' ? p.outputId : next.outputId,
        mode: p.mode === 'ptt' ? 'ptt' : 'vad',
        pttCode: typeof p.pttCode === 'string' && p.pttCode ? p.pttCode : null,
        vadDb: typeof p.vadDb === 'number' && Number.isFinite(p.vadDb) ? clamp(p.vadDb, VAD_MIN_DB, VAD_MAX_DB) : next.vadDb,
        userVolumes: volumes,
      };
    }
  } catch { /* defaults */ }
  cached = next;
  return next;
}

export function setVoiceSettings(patch: Partial<VoiceSettings>): VoiceSettings {
  const next = { ...getVoiceSettings(), ...patch };
  cached = next;
  try { storage()?.setItem(STORAGE_KEY, JSON.stringify(next)); } catch { /* best-effort */ }
  listeners.forEach((fn) => fn(next));
  return next;
}

export function onVoiceSettingsChange(fn: (s: VoiceSettings) => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

// A key's name for the settings screen: "`", "F13", "Right Ctrl".
export function keyLabel(code: string | null): string {
  if (!code) return 'Not set';
  const named: Record<string, string> = {
    Backquote: '`', Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']', Backslash: '\\',
    Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/', Space: 'Space',
    ControlLeft: 'Left Ctrl', ControlRight: 'Right Ctrl', AltLeft: 'Left Alt', AltRight: 'Right Alt',
    ShiftLeft: 'Left Shift', ShiftRight: 'Right Shift', MetaLeft: 'Left ⌘/Win', MetaRight: 'Right ⌘/Win',
    CapsLock: 'Caps Lock',
  };
  if (named[code]) return named[code];
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit\d$/.test(code)) return code.slice(5);
  if (/^Numpad/.test(code)) return `Num ${code.slice(6)}`;
  return code;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

// Test seam.
export function __resetVoiceSettings(): void {
  cached = null;
  listeners.clear();
}
