// Opt-in end-to-end run of the ChanServ adapters against real services:
// Ergo, UnrealIRCd+Anope and InspIRCd+Atheme in docker
// (infra/chanserv-e2e/compose.yaml). Two plain-IRC clients — a founder and a
// helper — register accounts, then the founder's ChanServController drives
// every action (status, register, roles, options, transfer, unregister)
// exactly as the app does.
//
//   make test-e2e-chanserv
//   # or, with the stacks already up:
//   CHANSERV_E2E=ergo,anope,atheme npx vitest run src/renderer/src/modules/chanserv/live.e2e.test.ts
//
// CHANSERV_E2E_WRITE=1 also saves every exchange as a fixture under
// engine/internal/services_e2e/fixtures/<stack>/chanserv-*.json, which
// chanserv.fixtures.test.ts replays in the normal (offline) test run.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { connect, type Socket } from 'node:net';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { IrcEvent } from '../engine/engine.types';
import { ChanServController } from './chanserv.controller';
import { getChanServAdapter } from './adapters';
import type { Operation } from './chanserv.types';
import { drive } from './drive.testutil';

const STACKS = (process.env.CHANSERV_E2E ?? '').split(',').map((s) => s.trim()).filter(Boolean) as Array<'ergo' | 'anope' | 'atheme'>;
const PORTS = { ergo: 16667, anope: 16668, atheme: 16669 } as const;
const LABELS = { ergo: 'ergo-2.19.1', anope: 'unrealircd-6 + anope-2.0', atheme: 'inspircd-3.18 + atheme-7.2.12' } as const;
const HOST = process.env.CHANSERV_E2E_HOST ?? '127.0.0.1';
const WRITE = process.env.CHANSERV_E2E_WRITE === '1';
const FIXTURES = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../../../engine/internal/services_e2e/fixtures');

// ---- a minimal IRC client ----------------------------------------------------

function parse(line: string): IrcEvent | null {
  let rest = line;
  let prefix = '';
  if (rest.startsWith('@')) rest = rest.slice(rest.indexOf(' ') + 1);
  if (rest.startsWith(':')) {
    const sp = rest.indexOf(' ');
    prefix = rest.slice(1, sp);
    rest = rest.slice(sp + 1);
  }
  const trailingAt = rest.indexOf(' :');
  const head = trailingAt >= 0 ? rest.slice(0, trailingAt) : rest;
  const params = head.split(' ').filter(Boolean);
  const cmd = params.shift() ?? '';
  if (trailingAt >= 0) params.push(rest.slice(trailingAt + 2));
  const from = prefix.split('!')[0] ?? '';
  return { Kind: cmd.toUpperCase(), From: from, Target: params[0] ?? '', Message: params.at(-1) ?? '', Args: params.slice(1), Raw: line };
}

class LiveIrc {
  private sock!: Socket;
  private buf = '';
  private readonly listeners = new Set<(e: IrcEvent) => void>();
  nick: string;
  version = '';
  network = '';

  constructor(nick: string) { this.nick = nick; }

  onEvent(fn: (e: IrcEvent) => void): () => void { this.listeners.add(fn); return () => this.listeners.delete(fn); }

  open(port: number): Promise<void> {
    return new Promise((ok, fail) => {
      this.sock = connect(port, HOST);
      this.sock.setEncoding('utf8');
      const timer = setTimeout(() => fail(new Error(`no 001 from :${port}`)), 60_000);
      this.sock.on('error', fail);
      this.sock.on('data', (chunk: string) => {
        this.buf += chunk;
        let nl: number;
        while ((nl = this.buf.indexOf('\n')) >= 0) {
          const line = this.buf.slice(0, nl).replace(/\r$/, '');
          this.buf = this.buf.slice(nl + 1);
          const e = parse(line);
          if (!e) continue;
          if (e.Kind === 'PING') { this.raw(`PONG :${e.Message}`); continue; }
          if (e.Kind === '001') { this.nick = e.Target; clearTimeout(timer); ok(); }
          if (e.Kind === '004') this.version = e.Args?.[1] ?? '';
          if (e.Kind === '005') for (const t of e.Args ?? []) if (t.startsWith('NETWORK=')) this.network = t.slice(8);
          if (e.Kind === '433') { this.nick += '_'; this.raw(`NICK ${this.nick}`); }
          for (const fn of [...this.listeners]) fn(e);
        }
      });
      this.raw(`NICK ${this.nick}`);
      this.raw(`USER ${this.nick} 0 * :boson chanserv e2e`);
    });
  }

  raw(line: string): void { this.sock.write(`${line}\r\n`); }
  privmsg(target: string, msg: string): void { this.raw(`PRIVMSG ${target} :${msg}`); }
  close(): void { try { this.raw('QUIT :done'); this.sock.end(); } catch { /* gone */ } }

  waitFor(pred: (e: IrcEvent) => boolean, ms = 15_000): Promise<IrcEvent> {
    return new Promise((ok, fail) => {
      const timer = setTimeout(() => { off(); fail(new Error('timed out waiting for an event')); }, ms);
      const off = this.onEvent((e) => { if (pred(e)) { clearTimeout(timer); off(); ok(e); } });
    });
  }
}

// A ChanServController on a live client, recording each exchange.
function controllerFor(c: LiveIrc, framework: 'ergo' | 'anope' | 'atheme') {
  let sent: string[] = [];
  let replies: string[][] = [];
  const ctl = new ChanServController((t, m) => {
    sent.push(m);
    replies.push([]);
    c.privmsg(t, m);
  }, {
    signals: () => ({ framework, version: c.version, network: c.network }),
    myAccount: () => c.nick,
  }, { quietMs: 1200, timeoutMs: 15_000 });
  c.onEvent((e) => {
    if (e.Kind === 'NOTICE' && e.From.toLowerCase() === 'chanserv' && replies.length) replies.at(-1)!.push(e.Message);
    ctl.handleEvent(e);
  });
  const take = () => { const r = { sent, replies }; sent = []; replies = []; return r; };
  return { ctl, take };
}

async function registerAccount(c: LiveIrc, stack: 'ergo' | 'anope' | 'atheme'): Promise<void> {
  const pw = `pw-${Math.random().toString(36).slice(2)}`;
  // RPL_LOGGEDIN, or NickServ saying so (Ergo without IRCv3 caps).
  const logged = c.waitFor((e) => e.Kind === '900' || (e.Kind === 'NOTICE' && /logged in as|now (?:identified|recognized)|registered/i.test(e.Message)), 20_000);
  c.privmsg('NickServ', stack === 'ergo' ? `REGISTER ${pw}` : `REGISTER ${pw} ${c.nick}@test.invalid`);
  await logged;
}

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe.skipIf(STACKS.length === 0)('ChanServ adapters against live services', () => {
  for (const stack of STACKS) {
    describe(stack, () => {
      const id = Math.random().toString(36).slice(2, 7);
      const chan = `#cse2e${id}`;
      const founder = new LiveIrc(`csf${id}`);
      const helper = new LiveIrc(`csh${id}`);
      let F: ReturnType<typeof controllerFor>;
      let H: ReturnType<typeof controllerFor>;

      // Run an action, check it, and keep the exchange as a fixture.
      async function step<T extends { kind: string }>(
        who: ReturnType<typeof controllerFor>, scenario: string, op: string, args: unknown[],
        run: () => Promise<T>, expectShape: Record<string, unknown>,
      ): Promise<T> {
        // Let the previous action's follow-up refreshes finish first.
        await Promise.all([F.ctl.idle(), H.ctl.idle()]);
        F.take(); H.take();
        const r = await run();
        let { sent, replies } = who.take();
        // eslint-disable-next-line prefer-const
        // A status check also reads Ergo's settings (a second command); the
        // fixture keeps the INFO exchange the adapter's info() parses.
        if (op === 'info') { sent = sent.slice(0, 1); replies = replies.slice(0, 1); }
        // Actions are followed by the controller's own refresh (INFO, the
        // role list): keep just the action's exchange, as its operation
        // would replay it.
        const replay = (getChanServAdapter(stack)[op as 'register'] as unknown as (...a: unknown[]) => Operation<unknown>).apply(getChanServAdapter(stack), args);
        const n = drive(replay, replies).sent.length;
        sent = sent.slice(0, n); replies = replies.slice(0, n);
        expect(r, `${scenario}: ${JSON.stringify(replies)}`).toMatchObject(expectShape);
        if (WRITE) {
          const dir = join(FIXTURES, stack);
          mkdirSync(dir, { recursive: true });
          const fx = { stack, scenario, ircdLabel: LABELS[stack], recorded: new Date().toISOString(), op, args, sent, replies, expect: expectShape };
          writeFileSync(join(dir, `chanserv-${scenario}.json`), `${JSON.stringify(fx, null, 2)}\n`);
        }
        return r;
      }

      const info = async (who: ReturnType<typeof controllerFor>, scenario: string, expectShape: Record<string, unknown>) => {
        const adapterInfo = who.ctl;
        return step(who, scenario, 'info', [chan], async () => {
          await adapterInfo.refresh(chan);
          const c = adapterInfo.channel(chan);
          return (c.infoStatus === 'ready' ? { kind: 'info', info: c.info } : c.infoError!) as { kind: string };
        }, expectShape);
      };

      beforeAll(async () => {
        await founder.open(PORTS[stack]);
        await helper.open(PORTS[stack]);
        F = controllerFor(founder, stack);
        H = controllerFor(helper, stack);
        await registerAccount(founder, stack);
        await registerAccount(helper, stack);
        const joined = founder.waitFor((e) => e.Kind === '366');
        founder.raw(`JOIN ${chan}`);
        await joined;
        const hj = helper.waitFor((e) => e.Kind === '366');
        helper.raw(`JOIN ${chan}`);
        await hj;
        await pause(1500); // services see the channel
      }, 90_000);

      afterAll(() => { founder.close(); helper.close(); });

      it('detects the dialect', () => {
        expect(F.ctl.getState().dialect).toBe(stack);
      });

      it('runs status → register → roles → options → transfer → unregister', async () => {
        // Readers of the fixture replay these through the adapter: ergo's
        // INFO is followed by a GET (readSettings), which `info` folds in.
        await info(F, 'info-unregistered', { kind: 'info', info: { registered: false } });
        await step(H, 'register-not-opped', 'register', [chan],
          () => H.ctl.register(chan), { kind: 'error', code: 'not-opped' });
        await step(F, 'register', 'register', [chan], () => F.ctl.register(chan), { kind: 'done' });
        await pause(500);
        await info(F, 'info-registered', { kind: 'info', info: { registered: true, founder: founder.nick.toLowerCase() } });

        await step(F, 'access-add', 'setAccess', [chan, helper.nick, 'op', null],
          () => F.ctl.setAccess(chan, helper.nick, 'op', null), { kind: 'done' });
        await pause(300);
        await step(F, 'access-list', 'listAccess', [chan], async () => {
          await F.ctl.loadAccess(chan);
          const c = F.ctl.channel(chan);
          return (c.accessStatus === 'ready' ? { kind: 'access', entries: c.access } : c.accessError!) as { kind: string };
        }, { kind: 'access' });
        expect(F.ctl.channel(chan).access?.map((e) => [e.account.toLowerCase(), e.role])).toContainEqual([helper.nick.toLowerCase(), 'op']);

        const option = stack === 'ergo' ? ['history', 'off'] : stack === 'anope' ? ['topiclock', true] : ['guard', true];
        await step(F, 'option-set', 'setOption', [chan, ...option],
          () => F.ctl.setOption(chan, option[0] as string, option[1] as string | boolean), { kind: 'done' });

        await step(F, 'access-remove', 'setAccess', [chan, helper.nick, null, 'op'],
          () => F.ctl.setAccess(chan, helper.nick, null, 'op'), { kind: 'done' });

        await step(F, 'transfer', 'transfer', [chan, helper.nick, founder.nick],
          () => F.ctl.transfer(chan, helper.nick), stack === 'ergo' ? { kind: 'done', pending: true } : { kind: 'done' });
        if (stack === 'ergo') {
          await pause(300);
          expect(H.ctl.getState().offers.map((o) => o.toLowerCase())).toContain(chan.toLowerCase());
          await step(H, 'transfer-accept', 'acceptTransfer', [chan], () => H.ctl.acceptTransfer(chan), { kind: 'done' });
        }
        await pause(500);
        await info(H, 'info-transferred', { kind: 'info', info: { registered: true, founder: helper.nick.toLowerCase() } });

        await step(F, 'unregister-denied', 'unregister', [chan],
          () => F.ctl.unregister(chan), { kind: 'error', code: 'access-denied' });
        await step(H, 'unregister', 'unregister', [chan], () => H.ctl.unregister(chan), { kind: 'done' });
        await pause(500);
        await info(H, 'info-after-unregister', { kind: 'info', info: { registered: false } });
      }, 180_000);
    });
  }
});
