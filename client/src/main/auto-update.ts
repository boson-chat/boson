// Auto-update wiring on top of electron-updater. Pulls new installer
// packages from the GitHub release for the current tag pattern
// (configured via electron-builder's `publish: github` block).
//
// Flow:
//   1. App starts → autoUpdater.checkForUpdates() fires automatically
//      ~10s after first window load. We delay so the renderer can paint
//      and the user isn't competing with a network spike on launch.
//   2. New version found → background download begins; renderer hears
//      "downloading" + progress events through a typed IPC channel.
//   3. Download complete → renderer shows "Restart to apply"; clicking
//      it invokes autoUpdater.quitAndInstall().
//   4. Periodic re-check every 6h while the app is running so a user
//      who never quits still picks up patches.
//
// The renderer also exposes a manual "Check for updates" button (see
// About panel) that calls checkNow() to short-circuit step 1.
//
// In dev (`process.defaultApp === true` or no version metadata on
// disk) electron-updater logs a complaint about needing a packaged
// app — we no-op the whole module in that case so `npm run dev`
// stays quiet.

import { app, BrowserWindow } from 'electron';
import type { UpdateInfo } from 'electron-updater';

// State the renderer needs to render the update banner. Single
// discriminated union so the IPC payload is small + the UI doesn't
// have to merge multiple async streams.
export type UpdateState =
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'up-to-date'; checkedAt: number }
  | { kind: 'available'; version: string }
  | { kind: 'downloading'; version: string; percent: number; bytesPerSecond: number }
  | { kind: 'ready'; version: string }
  | { kind: 'error'; message: string };

// Periodic re-check cadence. 6h is long enough to be invisible while
// still picking up overnight releases for users who never quit the app.
const PERIODIC_RECHECK_MS = 6 * 60 * 60 * 1000;
// Initial check delay after first window load. Avoids competing with
// the renderer's own bootstrapping (Supabase, engine, etc.).
const INITIAL_CHECK_DELAY_MS = 10 * 1000;

let updaterStarted = false;
let currentState: UpdateState = { kind: 'idle' };
const listeners = new Set<(s: UpdateState) => void>();

function setState(next: UpdateState): void {
  currentState = next;
  for (const fn of listeners) fn(next);
}

export function getUpdateState(): UpdateState {
  return currentState;
}

export function onUpdateState(fn: (s: UpdateState) => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

// Start the update lifecycle for a given window. Idempotent — repeat
// calls (e.g. multiple windows during dev) are no-ops after the first.
export function startAutoUpdater(win: BrowserWindow): void {
  if (updaterStarted) return;
  // Dev mode: electron-updater needs a packaged app to read its own
  // app-update.yml. There's no point trying in `npm run dev` — the
  // module just throws every check. Bail before importing it so we
  // don't even pay the require cost.
  if (process.defaultApp || !app.isPackaged) {
    return;
  }
  updaterStarted = true;

  // Require lazily so the heavy dependency only loads in packaged builds.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { autoUpdater } = require('electron-updater') as typeof import('electron-updater');

  // electron-updater wants its own logger; we route everything through
  // console so kubectl/electron logs see the same stream. The library
  // checks for a logger interface, not a class.
  autoUpdater.logger = {
    info: (...a: unknown[]) => console.info('[updater]', ...a),
    warn: (...a: unknown[]) => console.warn('[updater]', ...a),
    error: (...a: unknown[]) => console.error('[updater]', ...a),
    debug: (..._a: unknown[]) => {},
  };
  // We control the prompt UI ourselves — disable the built-in
  // "Update available" / "Update downloaded" dialogs.
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('checking-for-update', () => setState({ kind: 'checking' }));
  autoUpdater.on('update-not-available', () =>
    setState({ kind: 'up-to-date', checkedAt: Date.now() }),
  );
  autoUpdater.on('update-available', (info: UpdateInfo) =>
    setState({ kind: 'available', version: info.version }),
  );
  autoUpdater.on('download-progress', (p) => {
    const v = currentState.kind === 'available' || currentState.kind === 'downloading'
      ? ('version' in currentState ? currentState.version : 'unknown')
      : 'unknown';
    setState({
      kind: 'downloading',
      version: v,
      percent: Math.round(p.percent ?? 0),
      bytesPerSecond: Math.round(p.bytesPerSecond ?? 0),
    });
  });
  autoUpdater.on('update-downloaded', (info: UpdateInfo) =>
    setState({ kind: 'ready', version: info.version }),
  );
  autoUpdater.on('error', (err) =>
    setState({ kind: 'error', message: err instanceof Error ? err.message : String(err) }),
  );

  // Push every state change to the renderer too. We keep an internal
  // copy in `currentState` so the renderer's initial `getState` IPC
  // call gets the latest verdict even if the listener is attached
  // after the event fired.
  onUpdateState((s) => {
    if (!win.isDestroyed()) win.webContents.send('updater:state', s);
  });

  // First check on a short delay; periodic re-checks every 6h while
  // the app is running. Both wrapped in catch handlers so a transient
  // network failure doesn't bubble up as an unhandled rejection.
  setTimeout(() => {
    void autoUpdater.checkForUpdates().catch((err) =>
      setState({ kind: 'error', message: err instanceof Error ? err.message : String(err) }),
    );
  }, INITIAL_CHECK_DELAY_MS);
  setInterval(() => {
    void autoUpdater.checkForUpdates().catch(() => {
      // Silent on periodic-check failures; the existing state stays.
    });
  }, PERIODIC_RECHECK_MS);

  // Provide a manual-check entry point so the renderer's "Check for
  // updates" button can short-circuit the 6h cadence. Stashed on
  // module scope so the IPC handler in index.ts can reach it.
  manualCheck = async () => {
    try {
      await autoUpdater.checkForUpdates();
    } catch (err) {
      setState({ kind: 'error', message: err instanceof Error ? err.message : String(err) });
    }
  };
  installAndRestart = () => autoUpdater.quitAndInstall();
}

let manualCheck: () => Promise<void> = async () => {
  // Pre-start (or dev mode) — pretend the user is up to date so the
  // UI doesn't sit in `checking` forever.
  setState({ kind: 'up-to-date', checkedAt: Date.now() });
};
let installAndRestart: () => void = () => {
  // Pre-start — no-op. The renderer should never reach the "ready"
  // state without the updater having spun up, so this branch only
  // protects against accidental misuse.
};

export async function checkNow(): Promise<void> {
  return manualCheck();
}

export function applyDownloadedUpdate(): void {
  installAndRestart();
}
