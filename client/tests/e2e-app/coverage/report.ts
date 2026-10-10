// Turns the raw coverage collected during an E2E_COVERAGE=1 run (see
// config.ts) into per-layer reports mapped back to source files:
//
//   coverage/e2e/renderer/  index.html (V8 report) + lcov.info + coverage-summary.json
//   coverage/e2e/main/      index.html (V8 report) + lcov.info + coverage-summary.json
//   coverage/e2e/engine/    index.html (go tool cover) + coverage.out + lcov.info
//                           + packages.txt / functions.txt
//   coverage/e2e/summary.md per-layer totals + least-covered files
//
// Called from global-teardown.ts, so it runs after every coverage run,
// passing or not.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, join, relative, resolve } from 'node:path';
import MCR from 'monocart-coverage-reports';
import {
  APP_OUT_DIR, CLIENT_DIR, COVERAGE_DIR, RAW, REPO_ROOT, RENDERER_CHUNK_URL, isPreloadUrl,
} from './config';

type V8Entry = MCR.V8CoverageEntry;

interface Metric { covered: number; total: number }
interface LayerSummary {
  name: string;
  scope: string;
  lines: Metric;
  statements: Metric;
  functions?: Metric;
  branches?: Metric;
  files: Array<{ path: string; lines: Metric }>;
}

const pct = (m: Metric): string => (m.total === 0 ? 'n/a' : `${((100 * m.covered) / m.total).toFixed(1)}%`);
const cell = (m?: Metric): string => (m ? `${pct(m)} (${m.covered}/${m.total})` : '—');
const toMetric = (m: Metric): Metric => ({ covered: m.covered, total: m.total });

const readJson = <T>(path: string): T => JSON.parse(readFileSync(path, 'utf8')) as T;
const listFiles = (dir: string): string[] => (existsSync(dir) ? readdirSync(dir).map((f) => join(dir, f)) : []);

// Source files that count: the app's own TS under src/. Excludes
// node_modules, the shared workspace package, tests, and anything a
// sourcemap pulls in from outside the client (vendored or virtual modules).
function isAppSource(path: string, layer: 'renderer' | 'main'): boolean {
  const p = path.replace(/\\/g, '/');
  if (/(^|\/)node_modules\//.test(p)) return false;
  if (/\.(test|spec|int\.test)\.[cm]?[jt]sx?$/.test(p) || /\/__integration__\//.test(p)) return false;
  return layer === 'renderer'
    ? /(^|\/)src\/renderer\/src\//.test(p)
    : /(^|\/)src\/(main|preload)\//.test(p);
}

// Bundle + its sourcemap from disk. The renderer chunk is served from the
// app's loopback origin on a random port; key it by the built file so every
// launch's data merges onto the same entry.
function attachBuild(entry: V8Entry, file: string): V8Entry {
  const mapFile = `${file}.map`;
  return {
    ...entry,
    url: file,
    source: readFileSync(file, 'utf8'),
    ...(existsSync(mapFile) ? { sourceMap: readJson<unknown>(mapFile) } : {}),
  };
}

async function v8Layer(opts: {
  layer: 'renderer' | 'main';
  name: string;
  scope: string;
  entries: V8Entry[];
  nodeCoverageDir?: string;
}): Promise<LayerSummary | null> {
  const outputDir = join(COVERAGE_DIR, opts.layer);
  const mcr = MCR({
    name: `Boson e2e coverage — ${opts.name}`,
    outputDir,
    baseDir: CLIENT_DIR,
    // v8: the HTML report (with byte-level coverage). The istanbul-derived
    // lcov + json-summary count only lines that hold statements, so type
    // declarations, imports and comments neither pad nor drag the numbers;
    // summary.md uses those.
    reports: ['v8', ['lcovonly', { file: 'lcov.info' }], ['json-summary', { file: 'coverage-summary.json' }]],
    entryFilter: (entry: V8Entry) =>
      opts.layer === 'renderer'
        ? entry.url.startsWith(join(APP_OUT_DIR, 'renderer'))
        : entry.url.includes('out-e2e/main/') || isPreloadUrl(entry.url),
    sourceFilter: (sourcePath: string) => isAppSource(sourcePath, opts.layer),
    // Sources come out of the sourcemaps relative to the bundle; report them
    // relative to client/ (src/renderer/src/..., src/main/...).
    sourcePath: (filePath: string) => {
      const m = filePath.replace(/\\/g, '/').match(/(?:^|\/)(src\/(?:renderer\/src|main|preload)\/.*)$/);
      return m?.[1] ?? filePath;
    },
    logging: 'error',
  });
  if (opts.entries.length > 0) await mcr.add(opts.entries);
  if (opts.nodeCoverageDir && listFiles(opts.nodeCoverageDir).length > 0) await mcr.addFromDir(opts.nodeCoverageDir);
  const results = await mcr.generate();
  const summaryFile = join(outputDir, 'coverage-summary.json');
  if (!results || results.files.length === 0 || !existsSync(summaryFile)) return null;
  type Istanbul = Record<'lines' | 'statements' | 'functions' | 'branches', Metric>;
  const { total, ...files } = readJson<Record<string, Istanbul>>(summaryFile);
  if (!total) return null;
  return {
    name: opts.name,
    scope: opts.scope,
    lines: toMetric(total.lines),
    statements: toMetric(total.statements),
    functions: toMetric(total.functions),
    branches: toMetric(total.branches),
    files: Object.entries(files).map(([path, f]) => ({
      path: `client/${relative(CLIENT_DIR, resolve(CLIENT_DIR, path)).replace(/\\/g, '/')}`,
      lines: toMetric(f.lines),
    })),
  };
}

function rawV8Entries(): { renderer: V8Entry[]; preload: V8Entry[] } {
  const renderer: V8Entry[] = [];
  const preload: V8Entry[] = [];
  for (const file of listFiles(RAW.renderer)) {
    for (const entry of readJson<V8Entry[]>(file)) {
      const chunk = entry.url.match(RENDERER_CHUNK_URL)?.[1];
      if (chunk) {
        const built = join(APP_OUT_DIR, 'renderer', 'assets', chunk);
        if (existsSync(built)) renderer.push(attachBuild(entry, built));
      } else if (isPreloadUrl(entry.url) && existsSync(entry.url)) {
        preload.push(attachBuild(entry, entry.url));
      }
    }
  }
  return { renderer, preload };
}

// ---- engine (Go) -----------------------------------------------------------

function go(args: string[], cwd = REPO_ROOT): string {
  const r = spawnSync(process.env['GO'] ?? 'go', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`go ${args.join(' ')} failed: ${r.error?.message ?? r.stderr}`);
  return r.stdout;
}

// Each engine writes its counter file when it exits, which can trail the
// app's close() by a moment (Electron sends SIGTERM and doesn't wait).
async function waitForEngineFlush(timeoutMs = 15_000): Promise<void> {
  const launches = listFiles(RAW.launches).length;
  const counters = (): number => listFiles(RAW.engine).filter((f) => basename(f).startsWith('covcounters.')).length;
  const deadline = Date.now() + timeoutMs;
  while (counters() < launches && Date.now() < deadline) await new Promise((r) => setTimeout(r, 250));
  if (counters() < launches) {
    console.warn(`[e2e-coverage] only ${counters()}/${launches} engine processes flushed coverage counters`);
  }
}

function engineLayer(): LayerSummary | null {
  if (!listFiles(RAW.engine).some((f) => basename(f).startsWith('covmeta.'))) {
    console.warn('[e2e-coverage] no engine coverage — was the sidecar built with E2E_COVERAGE=1?');
    return null;
  }
  const outputDir = join(COVERAGE_DIR, 'engine');
  mkdirSync(outputDir, { recursive: true });
  const profile = join(outputDir, 'coverage.out');
  writeFileSync(join(outputDir, 'packages.txt'), go(['tool', 'covdata', 'percent', '-i', RAW.engine]));
  go(['tool', 'covdata', 'textfmt', '-i', RAW.engine, '-o', profile]);
  go(['tool', 'cover', `-html=${profile}`, '-o', join(outputDir, 'index.html')]);
  writeFileSync(join(outputDir, 'functions.txt'), go(['tool', 'cover', `-func=${profile}`]));

  // Profile lines: <import path>/<file>.go:<l0>.<c0>,<l1>.<c1> <stmts> <count>
  // (blocks from several processes are already merged by textfmt).
  const modulePath = go(['list', '-m']).trim();
  const files = new Map<string, { stmts: Metric; lines: Map<number, number> }>();
  for (const line of readFileSync(profile, 'utf8').split('\n').slice(1)) {
    const m = line.match(/^(.+\.go):(\d+)\.\d+,(\d+)\.\d+ (\d+) (\d+)$/);
    if (!m) continue;
    const [, importPath, l0, l1, n, count] = m as unknown as [string, string, string, string, string, string];
    const rel = importPath.startsWith(`${modulePath}/`) ? importPath.slice(modulePath.length + 1) : importPath;
    let f = files.get(rel);
    if (!f) files.set(rel, (f = { stmts: { covered: 0, total: 0 }, lines: new Map() }));
    f.stmts.total += Number(n);
    if (Number(count) > 0) f.stmts.covered += Number(n);
    for (let l = Number(l0); l <= Number(l1); l++) f.lines.set(l, Math.max(f.lines.get(l) ?? 0, Number(count)));
  }

  // lcov (paths relative to the repo root), so the engine can go to the
  // same tooling as the JS layers.
  const lcov: string[] = [];
  const summary: LayerSummary = {
    name: 'Engine (Go)',
    scope: 'engine/... packages linked into the sidecar',
    lines: { covered: 0, total: 0 },
    statements: { covered: 0, total: 0 },
    files: [],
  };
  for (const [rel, f] of [...files.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const hit = [...f.lines.values()].filter((c) => c > 0).length;
    lcov.push(`SF:${rel}`);
    for (const [l, c] of [...f.lines.entries()].sort(([a], [b]) => a - b)) lcov.push(`DA:${l},${c}`);
    lcov.push(`LF:${f.lines.size}`, `LH:${hit}`, 'end_of_record');
    summary.lines.covered += hit;
    summary.lines.total += f.lines.size;
    summary.statements.covered += f.stmts.covered;
    summary.statements.total += f.stmts.total;
    summary.files.push({ path: rel, lines: { covered: hit, total: f.lines.size } });
  }
  writeFileSync(join(outputDir, 'lcov.info'), lcov.join('\n') + '\n');
  return summary;
}

// ---- summary ---------------------------------------------------------------

function markdown(layers: LayerSummary[], top = 15): string {
  const out: string[] = [
    '## E2E coverage (real Electron app)',
    '',
    '| Layer | Scope | Lines | Statements | Functions | Branches |',
    '| --- | --- | --- | --- | --- | --- |',
    ...layers.map((l) => `| ${l.name} | ${l.scope} | ${cell(l.lines)} | ${cell(l.statements)} | ${cell(l.functions)} | ${cell(l.branches)} |`),
    '',
    `### ${top} least-covered files (by uncovered lines)`,
    '',
    '| File | Layer | Lines | Uncovered lines |',
    '| --- | --- | --- | --- |',
  ];
  const files = layers
    .flatMap((l) => l.files.map((f) => ({ ...f, layer: l.name, uncovered: f.lines.total - f.lines.covered })))
    .filter((f) => f.uncovered > 0)
    .sort((a, b) => b.uncovered - a.uncovered)
    .slice(0, top);
  for (const f of files) out.push(`| \`${f.path}\` | ${f.layer} | ${cell(f.lines)} | ${f.uncovered} |`);
  out.push(
    '',
    'Reports: `renderer/index.html`, `main/index.html`, `engine/index.html` (each layer also has `lcov.info`).',
    '',
  );
  return out.join('\n');
}

export async function generateE2eCoverageReport(): Promise<void> {
  const errors: string[] = [];
  const layers: LayerSummary[] = [];
  const attempt = async (name: string, fn: () => Promise<LayerSummary | null> | LayerSummary | null): Promise<void> => {
    try {
      const layer = await fn();
      if (layer) layers.push(layer);
      else errors.push(`${name}: no coverage data`);
    } catch (err) {
      errors.push(`${name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const { renderer, preload } = rawV8Entries();
  await attempt('renderer', () => v8Layer({
    layer: 'renderer', name: 'Renderer', scope: 'src/renderer/src', entries: renderer,
  }));
  await attempt('main', () => v8Layer({
    layer: 'main', name: 'Main + preload', scope: 'src/main, src/preload', entries: preload, nodeCoverageDir: RAW.main,
  }));
  await waitForEngineFlush();
  await attempt('engine', engineLayer);

  const md = markdown(layers);
  writeFileSync(join(COVERAGE_DIR, 'summary.md'), md);
  console.log(`\n${md}\nE2E coverage written to ${relative(process.cwd(), COVERAGE_DIR) || COVERAGE_DIR}`);
  if (errors.length > 0) throw new Error(`E2E coverage incomplete:\n  - ${errors.join('\n  - ')}`);
}
