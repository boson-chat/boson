// Opt-in code coverage for the real-app e2e suite (E2E_COVERAGE=1).
//
// Four layers, four collectors, one output tree (client/coverage/e2e/, or
// $E2E_COVERAGE_DIR):
//
//   renderer/  Preact/TS renderer. V8 precise coverage started by
//              electron-hook.cjs on every WebContents before its first
//              script runs, taken by the fixture just before the app closes.
//   main/      Electron main (NODE_V8_COVERAGE, flushed when the main
//              process exits) + the sandboxed preload (which runs in the
//              renderer's V8, so it arrives with the renderer data).
//   engine/    Go sidecar built with `go build -cover`; GOCOVERDIR is
//              inherited through the main process's env and the engine
//              writes its counters when it exits on SIGTERM.
//   backend/   Go API server of the account-mode stack, run on the host by
//              scripts/e2e-stack.mjs as a `-cover` build (E2E_COVERAGE=1
//              when the stack comes up). It runs for the whole session, so
//              the report asks it for a snapshot (SIGUSR1) instead of
//              waiting for it to exit. Counters cover the backend's whole
//              lifetime — `make test-e2e-app-coverage` restarts it first.
//
// Raw data accumulates under .raw/ across every launch (relaunches
// included); global-teardown.ts turns it into reports via report.ts.
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { APP_DIR, CLIENT_DIR, E2E_RUN_DIR, REPO_ROOT } from '../stack';

export const COVERAGE = process.env['E2E_COVERAGE'] === '1';

export { CLIENT_DIR, REPO_ROOT };
const here = dirname(fileURLToPath(import.meta.url));
export const APP_OUT_DIR = APP_DIR;
export const COVERAGE_DIR = resolve(CLIENT_DIR, process.env['E2E_COVERAGE_DIR'] || join('coverage', 'e2e'));
// Written by scripts/e2e-stack.mjs (keep in sync).
export const BACKEND_COVER_DIR = join(E2E_RUN_DIR, 'backend-cover');
export const BACKEND_PID_FILE = join(E2E_RUN_DIR, 'backend.pid');
export const ELECTRON_HOOK = join(here, 'electron-hook.cjs');

const RAW_DIR = join(COVERAGE_DIR, '.raw');
export const RAW = {
  root: RAW_DIR,
  renderer: join(RAW_DIR, 'renderer'),
  main: join(RAW_DIR, 'main'),
  engine: join(RAW_DIR, 'engine'),
  // One empty marker per app launch, so the report can wait for every
  // engine to have flushed its counters.
  launches: join(RAW_DIR, 'launches'),
};

// Renderer bundle chunks served from the app's loopback origin, and the
// preload bundle (reported under main/).
export const RENDERER_CHUNK_URL = /^http:\/\/127\.0\.0\.1:\d+\/assets\/([^/?#]+\.js)$/;
const PRELOAD_FILE = join(APP_OUT_DIR, 'preload', 'index.js');
export const isPreloadUrl = (url: string): boolean =>
  url === PRELOAD_FILE || url.replace(/^file:\/\//, '') === PRELOAD_FILE;
// Main-process bundle files (NODE_V8_COVERAGE reports them as file:// URLs).
export const isMainUrl = (url: string): boolean =>
  url.replace(/^file:\/\//, '').startsWith(join(APP_OUT_DIR, 'main') + sep);
