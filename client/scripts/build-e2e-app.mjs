#!/usr/bin/env node
// Builds the Electron app for the real-app e2e suite (tests/e2e-app/) into
// client/out-e2e/ — deliberately NOT client/out/, which a running
// `electron-vite dev` session owns. Produces a self-contained app dir:
//
//   out-e2e/package.json                     ("main": "main/index.js")
//   out-e2e/main, out-e2e/preload, out-e2e/renderer
//   out-e2e/resources/engine/engine-<os>-<arch>   (host sidecar)
//
// Launching Electron with `out-e2e` as the app path makes
// app.getAppPath() === out-e2e, so EngineSupervisor finds the sidecar at
// <appPath>/resources/engine exactly like an unpackaged dev build would.
//
// Build-time env is pinned so the bundle never talks to a developer's local
// backend or Supabase: both point at 127.0.0.1:9 (discard port — nothing
// listens, connections are refused immediately). The publishable key only
// has to be non-empty for the renderer to boot. Process env beats .env in
// Vite, so a developer's client/.env cannot leak into this build.
//
// Usage: node scripts/build-e2e-app.mjs [--skip-engine]
//   --skip-engine  reuse the sidecar already in out-e2e/resources/engine
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const clientDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = join(clientDir, '..');
const outDir = join(clientDir, 'out-e2e');
const skipEngine = process.argv.includes('--skip-engine');

function run(cmd, args, opts) {
  console.log(`$ ${cmd} ${args.join(' ')}`);
  const r = spawnSync(cmd, args, { stdio: 'inherit', shell: process.platform === 'win32', ...opts });
  if (r.status !== 0) {
    console.error(`${cmd} failed (exit ${r.status ?? r.signal})`);
    process.exit(r.status ?? 1);
  }
}

rmSync(join(outDir, 'main'), { recursive: true, force: true });
rmSync(join(outDir, 'preload'), { recursive: true, force: true });
rmSync(join(outDir, 'renderer'), { recursive: true, force: true });

run('npx', ['electron-vite', 'build', '--outDir', 'out-e2e'], {
  cwd: clientDir,
  env: {
    ...process.env,
    VITE_SUPABASE_URL: 'http://127.0.0.1:9',
    VITE_SUPABASE_PUBLISHABLE_KEY: 'e2e-placeholder-key',
    VITE_SUPABASE_ANON_KEY: 'e2e-placeholder-key',
    VITE_BOSON_API_URL: 'http://127.0.0.1:9',
    // Empty: the app must use its own sidecar via the preload bridge, never a
    // developer's `make engine-serve` from .env.
    VITE_ENGINE_URL: '',
    VITE_ENGINE_TOKEN: '',
  },
});

writeFileSync(
  join(outDir, 'package.json'),
  JSON.stringify(
    {
      name: 'boson-client',
      productName: 'Boson E2E',
      version: '0.0.0-e2e',
      private: true,
      type: 'module',
      main: 'main/index.js',
    },
    null,
    2,
  ) + '\n',
);

if (!skipEngine) {
  const os = process.platform === 'win32' ? 'windows' : process.platform;
  const arch = process.arch === 'arm64' ? 'arm64' : 'amd64';
  const ext = process.platform === 'win32' ? '.exe' : '';
  const engineDir = join(outDir, 'resources', 'engine');
  mkdirSync(engineDir, { recursive: true });
  run('go', ['build', '-o', join(engineDir, `engine-${os}-${arch}${ext}`), './engine/cmd/engine'], {
    cwd: repoRoot,
    env: { ...process.env, CGO_ENABLED: '0' },
  });
}

// Electron 44 downloads its binary lazily on first require() — do it now so
// the test run doesn't pay (or time out on) the download.
const electronBin = createRequire(import.meta.url)('electron');
console.log(`electron binary: ${electronBin}`);

console.log(`e2e app built in ${outDir}`);
