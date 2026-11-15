// Opt-in code coverage for the real-app e2e suite (E2E_COVERAGE=1).
//
// Two layers, one output tree (client/coverage/e2e/, or $E2E_COVERAGE_DIR):
//
//   renderer/  Preact/TS renderer. Playwright's JS coverage (page.coverage),
//              started before the page loads, taken just before the app
//              closes (desktop-app.ts).
//   engine/    The desktop app's Go binary (desktop/ and the engine/...
//              packages it links in), built with `go build -cover`; it writes
//              its counters to GOCOVERDIR when it exits on SIGTERM.
//
// Raw data accumulates under .raw/ across every launch (relaunches
// included); global-teardown.ts turns it into reports via report.ts.
import { join, resolve } from 'node:path';
import { APP_DIR, CLIENT_DIR, REPO_ROOT } from '../stack';

export const COVERAGE = process.env['E2E_COVERAGE'] === '1';

export { CLIENT_DIR, REPO_ROOT };
export const APP_OUT_DIR = APP_DIR;
export const COVERAGE_DIR = resolve(CLIENT_DIR, process.env['E2E_COVERAGE_DIR'] || join('coverage', 'e2e'));

const RAW_DIR = join(COVERAGE_DIR, '.raw');
export const RAW = {
  root: RAW_DIR,
  renderer: join(RAW_DIR, 'renderer'),
  engine: join(RAW_DIR, 'engine'),
  // One empty marker per app launch, so the report can wait for every
  // engine to have flushed its counters.
  launches: join(RAW_DIR, 'launches'),
};

// Renderer bundle chunks, as the app serves them on its loopback port.
export const RENDERER_CHUNK_URL = /^http:\/\/127\.0\.0\.1:\d+\/assets\/([^/?#]+\.js)$/;
