import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { classifyNickServReply, type NickServReplyKind } from './services';

// Ground-truth tests for the NickServ classifier.
//
// The Go e2e harness in engine/internal/services_e2e/ drives real
// REGISTER / IDENTIFY / DROP / INFO flows against live services
// containers (Ergo, Anope, Atheme) and writes each scenario's
// captured NickServ NOTICEs to a JSON fixture. This test loads those
// fixtures and asserts the classifier returns the expected kind for
// at least one event per scenario — so a phrasing change in any
// upstream services package surfaces here, not as a live user report.
//
// Fixtures are only present if the e2e suite has been run at least
// once (`make test-e2e-services-ergo` etc). When absent, the
// per-scenario tests skip with a note — keeping `vitest run` green
// on fresh checkouts.

// Resolve engine/internal/services_e2e/fixtures relative to THIS
// file, not cwd — vitest may be invoked from anywhere in the workspace.
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const FIXTURES_ROOT = resolve(
  __dirname,
  '../../../../../../engine/internal/services_e2e/fixtures',
);

interface CapturedEvent {
  kind: string;
  from: string;
  target: string;
  message: string;
  args?: string[];
  tags?: Record<string, string>;
}

interface ScenarioFixture {
  stack: 'ergo' | 'anope' | 'atheme';
  scenario: string;
  recorded: string;
  ircdLabel?: string;
  events: CapturedEvent[];
}

// What kind we expect to see at LEAST ONCE in the captured events for
// each scenario. The captured stream often contains multiple replies
// (e.g. a welcome notice + the actual register-success), so we don't
// pin the exact index — just assert the kind is present.
const SCENARIO_EXPECTATIONS: Record<string, NickServReplyKind> = {
  'register-no-confirm':       'registration-confirmed',
  'register-pending-confirm':  'registration-pending',
  'identify-success':          'identified-success',
  'identify-wrong-password':   'identify-failed',
  'drop-success':              'drop-success',
  // Two-step DROP prompt. Both Atheme and Ergo phrase this as
  // "Please confirm by replying with /msg NickServ DROP ..." or
  // "To confirm, run this command: /NS UNREGISTER ..." — the
  // service-confirm-replay handler subsumes both. Anope's
  // canonical "DROP CONFIRM" prompt also includes inline
  // `/msg NickServ DROP CONFIRM`, so it matches the same kind.
  'drop-confirm-prompt':       'service-confirm-replay',
  // Full DROP round-trip: connect → REGISTER → DROP → second-step
  // replay → success. We assert ONE event classifies as drop-success
  // (the post-replay "has been dropped" notice) — proving the
  // classifier walks all the way through without getting stuck.
  'drop-full-roundtrip':       'drop-success',
  'info':                      null as unknown as NickServReplyKind, // INFO replies aren't a single kind
};

function loadFixtures(stack: string): ScenarioFixture[] {
  const dir = join(FIXTURES_ROOT, stack);
  if (!existsSync(dir)) return [];
  const out: ScenarioFixture[] = [];
  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.json')) continue;
    const raw = readFileSync(join(dir, file), 'utf8');
    out.push(JSON.parse(raw) as ScenarioFixture);
  }
  return out;
}

// Anti-replay regression: the post-drop event stream contains
// engine-noise bodies like Anope's "Unknown command HELP. /msg
// NickServ HELP for help." and the RPL_LOGGEDOUT numeric. None of
// those bodies should classify as service-confirm-replay — that
// would re-fire commands at NickServ in a loop.
//
// Captured against drop-full-roundtrip fixtures on both Anope + Atheme.
describe('classifier — post-drop noise must NOT replay', () => {
  for (const stack of ['anope', 'atheme']) {
    const fixtures = loadFixtures(stack);
    const fx = fixtures.find((f) => f.scenario === 'drop-full-roundtrip');
    if (!fx) {
      it.skip(`${stack}/drop-full-roundtrip fixture missing — run e2e to capture`, () => {});
      continue;
    }
    it(`${stack}: no post-drop body classifies as service-confirm-replay`, () => {
      // Find the first event whose body matches a drop-success
      // pattern. Everything AFTER that index is the "tail" — what
      // we want to make sure isn't replay-bait.
      const successIdx = fx.events.findIndex((e) =>
        classifyNickServReply(e.message) === 'drop-success',
      );
      const tail = successIdx >= 0
        ? fx.events.slice(successIdx)
        : fx.events;
      const offenders = tail.filter(
        (e) => classifyNickServReply(e.message) === 'service-confirm-replay',
      );
      const debug = tail
        .map((e, i) => `  [+${i}] ${e.kind}/${e.from}: ${JSON.stringify(e.message)} → ${classifyNickServReply(e.message)}`)
        .join('\n');
      expect(offenders, `service-confirm-replay false-matches in post-drop tail:\n${debug}`).toEqual([]);
    });
  }
});

describe('classifier — ground-truth fixtures', () => {
  for (const stack of ['ergo', 'anope', 'atheme']) {
    describe(stack, () => {
      const fixtures = loadFixtures(stack);
      if (fixtures.length === 0) {
        // Self-skip with a hint. Keeps `vitest run` green on a fresh
        // checkout where the e2e harness hasn't been exercised yet.
        it.skip(`no fixtures for ${stack} (run \`make test-e2e-services-${stack}\` to generate)`, () => {});
        return;
      }
      for (const fx of fixtures) {
        const expected = SCENARIO_EXPECTATIONS[fx.scenario];
        if (expected === undefined) {
          it(`${fx.scenario} — no expectation registered (recording only)`, () => {
            // Still useful as a presence check.
            expect(fx.events.length).toBeGreaterThan(0);
          });
          continue;
        }
        if (expected === null) {
          // Skipping kind assertion for diagnostic-only scenarios (e.g. INFO).
          it.skip(`${fx.scenario} — diagnostic-only, no kind assertion`, () => {});
          continue;
        }
        it(`${fx.scenario} → at least one event classifies as ${expected}`, () => {
          const kinds = fx.events.map((e) => classifyNickServReply(e.message));
          // Surface the captured bodies in the assertion message so
          // a failure shows what the server actually said, side by
          // side with what we classified them as.
          const debug = fx.events
            .map((e, i) => `  [${i}] ${e.kind}/${e.from}: ${JSON.stringify(e.message)} → ${kinds[i]}`)
            .join('\n');
          expect(kinds, `expected ${expected} in:\n${debug}`).toContain(expected);
        });
      }
    });
  }
});
