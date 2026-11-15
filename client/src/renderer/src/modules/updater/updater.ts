// The in-app updater, as the renderer sees it: the state the shell's
// UpdaterService (desktop/updater.go) pushes, and the bridge the shell
// installs as window.bosonUpdater (platform/wails.ts). Absent in a browser,
// in tests unless stubbed, and on iOS (no self-update there).

import { useEffect, useState } from 'preact/hooks';

export type UpdateState =
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'up-to-date'; checkedAt: number }
  // manual: this copy can't install it itself (no signed manifest, too old,
  // or macOS runs it translocated / from a read-only disk); Apply opens the
  // release page. message says why, when there's something to say.
  | { kind: 'available'; version: string; manual?: boolean; message?: string; notes?: string }
  | { kind: 'downloading'; version: string; percent: number; bytesPerSecond: number; notes?: string }
  // Staged and verified: Apply ("Restart to update") swaps it in and
  // relaunches (Android: hands it to the system installer).
  | { kind: 'ready'; version: string; notes?: string }
  | { kind: 'error'; message: string; version?: string };

export interface UpdaterBridge {
  getState(): Promise<UpdateState>;
  checkNow(): Promise<void>;
  // Start downloading an available update. Older shells lack it.
  download?(): Promise<void>;
  applyDownloadedUpdate(): Promise<void>;
  onState(fn: (s: UpdateState) => void): () => void;
  getAutoInstall?(): Promise<boolean>;
  setAutoInstall?(on: boolean): Promise<void>;
}

export function getUpdater(): UpdaterBridge | null {
  if (typeof window === 'undefined') return null;
  return (window as unknown as { bosonUpdater?: UpdaterBridge }).bosonUpdater ?? null;
}

// The live update state: the shell's current state, then every push. A push
// is newer than the initial read, whichever lands first (under Wails the
// read and the pushes arrive by separate routes).
export function useUpdateState(updater: UpdaterBridge | null = getUpdater()): UpdateState {
  const [state, setState] = useState<UpdateState>({ kind: 'idle' });
  useEffect(() => {
    if (!updater) return;
    let unsubscribed = false;
    let pushed = false;
    void updater.getState().then((s) => { if (!unsubscribed && !pushed) setState(s); }).catch(() => {});
    const off = updater.onState((s) => { pushed = true; setState(s); });
    return () => { unsubscribed = true; off(); };
  }, [updater]);
  return state;
}
