#!/usr/bin/env node
// Builds the engine for the web build: engine/cmd/wasm with GOOS=js
// GOARCH=wasm → src/renderer/src/platform/web/gen/engine.wasm, plus the
// matching wasm_exec.js from the same Go toolchain (they must match).
// `npm run build:web` runs it first; the files are gitignored.
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const clientDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = join(clientDir, '..');
const gen = join(clientDir, 'src', 'renderer', 'src', 'platform', 'web', 'gen');
mkdirSync(gen, { recursive: true });

const goroot = spawnSync('go', ['env', 'GOROOT'], { encoding: 'utf8' });
if (goroot.status !== 0) {
  console.error('go is needed to build the web engine');
  process.exit(1);
}
const root = goroot.stdout.trim();
const execJs = [join(root, 'lib', 'wasm', 'wasm_exec.js'), join(root, 'misc', 'wasm', 'wasm_exec.js')]
  .find((p) => { try { return statSync(p).isFile(); } catch { return false; } });
if (!execJs) {
  console.error(`wasm_exec.js not found under ${root}`);
  process.exit(1);
}
copyFileSync(execJs, join(gen, 'wasm_exec.js'));

const out = join(gen, 'engine.wasm');
const r = spawnSync('go', ['build', '-trimpath', '-ldflags=-s -w', '-o', out, './engine/cmd/wasm'], {
  cwd: repoRoot,
  stdio: 'inherit',
  env: { ...process.env, GOOS: 'js', GOARCH: 'wasm', CGO_ENABLED: '0' },
});
if (r.status !== 0) process.exit(r.status ?? 1);
console.log(`engine.wasm: ${(statSync(out).size / 1e6).toFixed(1)} MB`);
