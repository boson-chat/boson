#!/usr/bin/env node
// Builds the Wails shell for the real-app e2e suite, as a server-mode binary
// (`go build -tags server`): the same Go services and renderer, served over
// HTTP so Playwright can drive it in Chromium (tests/e2e-app with
// E2E_SHELL=wails). The renderer bundle is the e2e one from
// build-e2e-app.mjs (pinned to the e2e stack), so run that first or pass
// --with-renderer to do both.
//
//   out-e2e/renderer  →  desktop/frontend/dist  →  desktop/bin/boson-e2e-server
//
// With E2E_COVERAGE=1 the binary is a `go build -cover` build of the shell and
// the engine (tests/e2e-app/coverage), and the renderer gets source maps.
//
// Usage: node scripts/build-e2e-wails.mjs [--with-renderer]
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const clientDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = join(clientDir, '..');
const desktopDir = join(repoRoot, 'desktop');
const outDir = resolve(clientDir, process.env.E2E_OUT_DIR || 'out-e2e');

function run(cmd, args, opts) {
  console.log(`$ ${cmd} ${args.join(' ')}`);
  const r = spawnSync(cmd, args, { stdio: 'inherit', shell: process.platform === 'win32', ...opts });
  if (r.status !== 0) {
    console.error(`${cmd} failed (exit ${r.status ?? r.signal})`);
    process.exit(r.status ?? 1);
  }
}

if (process.argv.includes('--with-renderer')) {
  run('node', [join(clientDir, 'scripts', 'build-e2e-app.mjs'), '--skip-engine'], { cwd: clientDir });
}
const renderer = join(outDir, 'renderer');
if (!existsSync(join(renderer, 'index.html'))) {
  console.error(`${renderer} is missing — run \`npm run build:e2e-app\` first (or pass --with-renderer).`);
  process.exit(1);
}

const dist = join(desktopDir, 'frontend', 'dist');
rmSync(dist, { recursive: true, force: true });
cpSync(renderer, dist, { recursive: true });
// The tracked placeholder (desktop/.gitignore), so the tree stays clean.
writeFileSync(join(dist, '.gitkeep'), '');

// cgo: macOS's server build still links the notifications package's cgo
// code; elsewhere the server build is pure Go (no GTK/WebKit needed). On
// macOS the selected Command Line Tools may not match the SDK, so prefer
// Xcode's toolchain when it's installed.
const env = { ...process.env, CGO_ENABLED: process.platform === 'darwin' ? '1' : '0' };
if (process.platform === 'darwin') {
  if (!env.DEVELOPER_DIR && existsSync('/Applications/Xcode.app/Contents/Developer')) {
    env.DEVELOPER_DIR = '/Applications/Xcode.app/Contents/Developer';
  }
  // Same minimum as the Wails Taskfile (macOS 12).
  env.MACOSX_DEPLOYMENT_TARGET = '12.0';
  env.CGO_CFLAGS = `${env.CGO_CFLAGS ?? ''} -mmacosx-version-min=12.0`.trim();
  env.CGO_LDFLAGS = `${env.CGO_LDFLAGS ?? ''} -mmacosx-version-min=12.0`.trim();
}
const bin = join(desktopDir, 'bin', `boson-e2e-server${process.platform === 'win32' ? '.exe' : ''}`);
// The e2e bundle talks to the e2e backend; let the API proxy reach it.
const stack = JSON.parse(readFileSync(join(repoRoot, 'infra', 'e2e', 'stack.json'), 'utf8'));
const version = JSON.parse(readFileSync(join(clientDir, 'package.json'), 'utf8')).version;
const ldflags = `-X main.apiBase=${stack.backend.url} -X main.devBuild=true -X main.appVersion=${version}`;
const cover = process.env.E2E_COVERAGE === '1'
  ? ['-cover', '-coverpkg=github.com/boson-chat/boson/desktop,github.com/boson-chat/boson/engine/...']
  : [];
run('go', ['build', '-tags', 'server', ...cover, '-ldflags', ldflags, '-o', bin, '.'], { cwd: desktopDir, env });
console.log(`wails e2e server built: ${bin}`);
