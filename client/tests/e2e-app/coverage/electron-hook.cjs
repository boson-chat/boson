// Coverage hook for the real-app e2e suite. Preloaded into the Electron MAIN
// process with `-r` (ahead of the app's own main bundle) only when
// E2E_COVERAGE=1 — see fixtures.ts. Never part of the app build.
//
// Renderer coverage has to start before the page's first script runs, or
// module top-level code (the whole bootstrap) would be missed. Playwright's
// page.coverage can only start once Playwright has handed us the Page, which
// is after the main window has begun loading. So instead we attach Electron's
// own DevTools client (webContents.debugger) the moment each WebContents is
// created and start V8 precise coverage there; V8 keeps that state across
// the window's navigation to the app origin.
//
// The fixture calls globalThis.__bosonE2ETakeCoverage() via app.evaluate()
// just before closing the app and gets the raw V8 ScriptCoverage entries.
'use strict';
const { app, webContents } = require('electron');

app.on('web-contents-created', (_event, wc) => {
  const dbg = wc.debugger;
  try {
    dbg.attach('1.3');
  } catch (err) {
    console.error('[e2e-coverage] debugger attach failed:', err);
    return;
  }
  dbg
    .sendCommand('Profiler.enable')
    .then(() => dbg.sendCommand('Profiler.startPreciseCoverage', { callCount: true, detailed: true }))
    .catch((err) => console.error('[e2e-coverage] startPreciseCoverage failed:', err));
});

globalThis.__bosonE2ETakeCoverage = async () => {
  const out = [];
  for (const wc of webContents.getAllWebContents()) {
    if (wc.isDestroyed() || !wc.debugger.isAttached()) continue;
    try {
      const { result } = await wc.debugger.sendCommand('Profiler.takePreciseCoverage');
      out.push(...result);
    } catch (err) {
      console.error('[e2e-coverage] takePreciseCoverage failed:', err);
    }
  }
  return out;
};
