// Every dialect's command mapping and reply parsing, replayed against a
// corpus of reply transcripts (./fixtures/*.json, transcribed verbatim from
// each services package's source) plus — when present — transcripts captured
// from real services by the opt-in docker suite
// (engine/internal/services_e2e/fixtures/<stack>/chanserv-*.json, written by
// `make test-e2e-chanserv`).
import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getChanServAdapter, type ChanServAdapter } from './adapters';
import type { ChanServDialect, Operation } from './chanserv.types';
import { drive } from './drive.testutil';

interface FixtureCase {
  name: string;
  dialect?: ChanServDialect;
  op: keyof ChanServAdapter;
  args: unknown[];
  sent: string[];
  replies: string[][];
  expect: Record<string, unknown> & { absent?: string[] };
  absent?: string[];
}

interface FixtureFile {
  dialect?: ChanServDialect;
  source: string;
  cases: FixtureCase[];
}

const here = dirname(fileURLToPath(import.meta.url));

function runCase(dialect: ChanServDialect, c: FixtureCase): void {
  const adapter = getChanServAdapter(c.dialect ?? dialect);
  const method = adapter[c.op] as unknown as ((...a: unknown[]) => Operation<unknown>) | undefined;
  expect(method, `${adapter.id} has no ${String(c.op)}`).toBeTypeOf('function');
  const op = method!.apply(adapter, c.args);
  const { result, sent } = drive(op, c.replies);
  expect(sent).toEqual(c.sent);
  const { absent, ...want } = c.expect;
  expect(result).toMatchObject(want);
  const info = (result as { info?: Record<string, unknown> }).info;
  for (const field of [...(absent ?? []), ...(c.absent ?? [])]) expect(info?.[field]).toBeUndefined();
}

const files = readdirSync(join(here, 'fixtures')).filter((f) => f.endsWith('.json')).sort();

describe('ChanServ fixture corpus', () => {
  it('covers every dialect', () => {
    const seen = new Set<string>();
    for (const f of files) {
      const fx = JSON.parse(readFileSync(join(here, 'fixtures', f), 'utf8')) as FixtureFile;
      for (const c of fx.cases) seen.add(c.dialect ?? fx.dialect!);
    }
    expect([...seen].sort()).toEqual(['anope', 'atheme', 'ergo', 'generic', 'q', 'x']);
  });

  for (const f of files) {
    const fx = JSON.parse(readFileSync(join(here, 'fixtures', f), 'utf8')) as FixtureFile;
    describe(f, () => {
      for (const c of fx.cases) it(c.name, () => runCase(c.dialect ?? fx.dialect!, c));
    });
  }
});

// ---- Captured from real services (opt-in docker suite) -------------------

interface CapturedFixture {
  stack: 'ergo' | 'anope' | 'atheme';
  scenario: string;
  ircdLabel?: string;
  // The adapter call the Go driver made, and what it expects.
  op: keyof ChanServAdapter;
  args: unknown[];
  sent: string[];
  replies: string[][];
  expect: Record<string, unknown>;
}

const CAPTURED = resolve(here, '../../../../../../engine/internal/services_e2e/fixtures');

describe('ChanServ transcripts captured from live services', () => {
  for (const stack of ['ergo', 'anope', 'atheme'] as const) {
    const dir = join(CAPTURED, stack);
    const found = existsSync(dir) ? readdirSync(dir).filter((f) => f.startsWith('chanserv-') && f.endsWith('.json')) : [];
    if (!found.length) {
      it.skip(`${stack}: none captured (run \`make test-e2e-chanserv\`)`, () => {});
      continue;
    }
    describe(stack, () => {
      for (const f of found.sort()) {
        const fx = JSON.parse(readFileSync(join(dir, f), 'utf8')) as CapturedFixture;
        it(`${fx.scenario} (${fx.ircdLabel ?? stack})`, () => runCase(stack, { ...fx, name: fx.scenario }));
      }
    });
  }
});
