// The engine dying under the app, in either shell. Electron runs it as a
// child process (killed with SIGKILL, and restarted by main); the Wails shell
// runs it in-process, where the e2e build's CrashEngine hook ends the session
// the same way — IRC connections dropped without a QUIT, the renderer's
// connection lost — and the renderer reconnects to a new session.
import { execFileSync } from 'node:child_process';
import type { ElectronApplication } from '@playwright/test';
import { WAILS_SHELL, wailsE2E } from '../wails-shell';

// Identifies the running engine: its PID under Electron, its session under
// Wails. A different value after a crash means a new engine. Throws when
// there is none.
export async function engineId(app: ElectronApplication): Promise<number> {
  if (WAILS_SHELL) {
    const id = await wailsE2E<number>(app, 'engineSession');
    if (!id) throw new Error('no engine session open');
    return id;
  }
  const main = app.process().pid!;
  const rows = execFileSync('ps', ['-A', '-o', 'pid=,ppid=,command='], { encoding: 'utf8' }).split('\n');
  for (const row of rows) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(row);
    if (m && Number(m[2]) === main && /engine-[a-z]+-[a-z0-9]+/.test(m[3]!)) return Number(m[1]);
  }
  throw new Error(`no engine child of Electron main process ${main}`);
}

// Kills the engine the hard way (no QUIT reaches IRC). Returns the engineId
// it had.
export async function crashEngine(app: ElectronApplication): Promise<number> {
  const id = await engineId(app);
  if (WAILS_SHELL) await wailsE2E(app, 'crashEngine');
  else process.kill(id, 'SIGKILL');
  return id;
}
