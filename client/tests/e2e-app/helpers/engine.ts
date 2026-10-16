// The engine dying under the app. It runs in-process, so the e2e build's
// CrashEngine hook (desktop/e2e.go) ends its session the way a crash would:
// IRC connections dropped without a QUIT, the renderer's connection lost.
// The renderer then reconnects to a new session.
import { e2eHook, type App } from '../desktop-app';

// Identifies the running engine session. A different value after a crash
// means a new one. Throws when there is none.
export async function engineId(app: App): Promise<number> {
  const id = await e2eHook<number>(app, 'engineSession');
  if (!id) throw new Error('no engine session open');
  return id;
}

// Kills the engine the hard way (no QUIT reaches IRC). Returns the engineId
// it had.
export async function crashEngine(app: App): Promise<number> {
  const id = await engineId(app);
  await e2eHook(app, 'crashEngine');
  return id;
}
