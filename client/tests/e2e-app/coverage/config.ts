// Opt-in code coverage for the real-app e2e suite (E2E_COVERAGE=1).
//
// Three layers, three collectors, one output tree (client/coverage/e2e/):
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
//
// Raw data accumulates under .raw/ across every launch (relaunches
// included); global-teardown.ts turns it into reports via report.ts.
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const COVERAGE = process.env['E2E_COVERAGE'] === '1';

const here = dirname(fileURLToPath(import.meta.url));
export const CLIENT_DIR = resolve(here, '../../..');
export const REPO_ROOT = resolve(CLIENT_DIR, '..');
export const APP_OUT_DIR = join(CLIENT_DIR, 'out-e2e');
export const COVERAGE_DIR = join(CLIENT_DIR, 'coverage', 'e2e');
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
export const isPreloadUrl = (url: string): boolean => /[\\/]out-e2e[\\/]preload[\\/]index\.js$/.test(url);
