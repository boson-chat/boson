import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { IrcEvent } from '../engine/engine.types';
import { ChanServController } from './chanserv.controller';
import type { DialectSignals } from './detect';
import { ChanServRunner } from './runner';
import { ErgoChanServ } from './adapters';

// A fake services network: answers PRIVMSGs to the service with scripted
// NOTICE batches, delivered asynchronously like a real server.
function fakeNet(script: (target: string, body: string) => string[] | 'nosuchnick' | null, from = 'ChanServ') {
  const sent: Array<[string, string]> = [];
  let deliver: (e: IrcEvent) => void = () => {};
  const send = (target: string, body: string): void => {
    sent.push([target, body]);
    const reply = script(target, body);
    setTimeout(() => {
      if (reply === 'nosuchnick') {
        deliver({ Kind: '401', From: 'irc.test', Target: 'ada', Message: 'No such nick/channel', Args: [target, 'No such nick/channel'], Raw: '' });
        return;
      }
      for (const line of reply ?? []) deliver({ Kind: 'NOTICE', From: from, Target: 'ada', Message: line, Raw: '' });
    }, 5);
  };
  return { sent, send, attach: (fn: (e: IrcEvent) => void) => { deliver = fn; }, emit: (e: IrcEvent) => deliver(e) };
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe('ChanServRunner', () => {
  it('runs operations one at a time and claims their replies', async () => {
    const listeners = new Set<(e: IrcEvent) => void>();
    const sent: string[] = [];
    const runner = new ChanServRunner({
      privmsg: (_t, m) => {
        sent.push(m);
        setTimeout(() => { for (const fn of listeners) fn({ Kind: 'NOTICE', From: 'ChanServ', Target: 'ada', Message: `Channel ${m.split(' ')[1]} is not registered`, Raw: '' }); }, 5);
      },
      onEvent: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
    }, { quietMs: 50 });
    const a = new ErgoChanServ();
    const p1 = runner.run('ChanServ', a.info('#one'));
    const p2 = runner.run('ChanServ', a.info('#two'));
    await vi.advanceTimersByTimeAsync(1);
    expect(sent).toEqual(['INFO #one']); // the second waits its turn
    await vi.advanceTimersByTimeAsync(20);
    expect(await p1).toMatchObject({ kind: 'info', info: { channel: '#one', registered: false } });
    await vi.advanceTimersByTimeAsync(20);
    expect(await p2).toMatchObject({ kind: 'info', info: { channel: '#two', registered: false } });
    expect(sent).toEqual(['INFO #one', 'INFO #two']);
  });

  it('times out when the service never answers', async () => {
    const runner = new ChanServRunner({ privmsg: () => {}, onEvent: () => () => {} }, { timeoutMs: 1000 });
    const p = runner.run('ChanServ', new ErgoChanServ().info('#dev'));
    await vi.advanceTimersByTimeAsync(1001);
    expect(await p).toMatchObject({ kind: 'error', code: 'timeout' });
  });

  it('settles a multi-line reply after the quiet period', async () => {
    const listeners = new Set<(e: IrcEvent) => void>();
    const runner = new ChanServRunner({
      privmsg: () => {
        setTimeout(() => {
          for (const line of ['Channel #dev is registered', 'Founder: ada', 'Registered at: Sat, 14 Nov 2026 10:00:00 UTC']) {
            for (const fn of listeners) fn({ Kind: 'NOTICE', From: 'chanserv', Target: 'ada', Message: line, Raw: '' });
          }
        }, 5);
      },
      onEvent: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
    }, { quietMs: 300 });
    let result: unknown;
    void runner.run('ChanServ', new ErgoChanServ().info('#dev')).then((r) => { result = r; });
    await vi.advanceTimersByTimeAsync(200);
    expect(result).toBeUndefined();
    await vi.advanceTimersByTimeAsync(200);
    expect(result).toMatchObject({ kind: 'info', info: { founder: 'ada' } });
  });
});

describe('ChanServController', () => {
  let signals: DialectSignals;
  let account: string | undefined;

  function make(net: ReturnType<typeof fakeNet>) {
    const ctl = new ChanServController(net.send, { signals: () => signals, myAccount: () => account }, { quietMs: 50, timeoutMs: 2000 });
    net.attach((e) => ctl.handleEvent(e));
    return ctl;
  }

  beforeEach(() => {
    signals = { version: 'ergo-2.19.1' };
    account = 'ada';
  });

  it('detects the dialect and caches INFO per channel', async () => {
    const net = fakeNet((_t, body) => body === 'INFO #dev'
      ? ['Channel #dev is registered', 'Founder: ada', 'Registered at: Sat, 14 Nov 2026 10:00:00 UTC']
      : body.startsWith('GET ') ? ['The stored channel history setting is: default'] : null);
    const ctl = make(net);
    expect(ctl.getState()).toMatchObject({ dialect: 'ergo', label: 'Ergo' });
    ctl.ensureInfo('#dev');
    expect(ctl.channel('#DEV').infoStatus).toBe('loading');
    await vi.advanceTimersByTimeAsync(500);
    expect(ctl.channel('#dev')).toMatchObject({ infoStatus: 'ready', info: { founder: 'ada', values: { history: 'default' } } });
    expect(ctl.getState().present).toBe(true);
    ctl.ensureInfo('#dev');
    await vi.advanceTimersByTimeAsync(500);
    expect(net.sent.filter(([, b]) => b === 'INFO #dev')).toHaveLength(1);
  });

  it('waits for detection before asking, then asks', async () => {
    signals = { version: 'UnrealIRCd-6.1.8' };
    const net = fakeNet(() => ['Channel \x02#dev\x02 isn\'t registered.']);
    const ctl = make(net);
    ctl.ensureInfo('#dev');
    await vi.advanceTimersByTimeAsync(100);
    expect(net.sent).toEqual([]);
    signals = { version: 'UnrealIRCd-6.1.8', framework: 'anope' };
    ctl.updateSignals();
    await vi.advanceTimersByTimeAsync(200);
    expect(net.sent).toEqual([['ChanServ', 'INFO #dev']]);
    expect(ctl.channel('#dev')).toMatchObject({ infoStatus: 'ready', info: { registered: false } });
  });

  it('marks ChanServ absent on ERR_NOSUCHNICK and stops asking', async () => {
    signals = { version: 'hybrid-8', framework: 'unknown' };
    const net = fakeNet(() => 'nosuchnick');
    const ctl = make(net);
    ctl.ensureInfo('#dev');
    await vi.advanceTimersByTimeAsync(100);
    expect(ctl.getState()).toMatchObject({ dialect: 'generic', present: false, absentReason: 'no-service' });
    void ctl.refresh('#other');
    await vi.advanceTimersByTimeAsync(100);
    expect(net.sent).toHaveLength(1);
  });

  it('treats Ergo with registration off as absent', async () => {
    const net = fakeNet(() => ['This command has been disabled by the server administrators']);
    const ctl = make(net);
    ctl.ensureInfo('#dev');
    await vi.advanceTimersByTimeAsync(200);
    expect(ctl.getState()).toMatchObject({ present: false, absentReason: 'disabled' });
  });

  it('QuakeNet: nothing is sent, the panel is off', async () => {
    signals = { version: 'u2.10.12.10+snircd(1.3.4a)', network: 'QuakeNet' };
    const net = fakeNet(() => null, 'Q');
    const ctl = make(net);
    ctl.ensureInfo('#dev');
    await vi.advanceTimersByTimeAsync(200);
    expect(ctl.getState()).toMatchObject({ dialect: 'q', present: false });
    expect(net.sent).toEqual([]);
  });

  it('Undernet: asks X, read-only', async () => {
    signals = { version: 'u2.10.12.19', network: 'UnderNet' };
    const net = fakeNet(() => ['#dev is registered by:', 'ada - last seen: 1 day ago'], 'X');
    const ctl = make(net);
    ctl.ensureInfo('#dev');
    await vi.advanceTimersByTimeAsync(200);
    expect(net.sent).toEqual([['X', 'CHANINFO #dev']]);
    expect(ctl.channel('#dev').info).toMatchObject({ registered: true, founder: 'ada' });
    expect(ctl.getState().caps).toMatchObject({ register: false, access: false, transfer: null });
  });

  it('register refuses guests without asking', async () => {
    account = undefined;
    const net = fakeNet(() => null);
    const ctl = make(net);
    expect(await ctl.register('#dev')).toMatchObject({ kind: 'error', code: 'not-logged-in' });
    expect(net.sent).toEqual([]);
  });

  it('register then refreshes the status', async () => {
    let registered = false;
    const net = fakeNet((_t, body) => {
      if (body === 'REGISTER #dev') { registered = true; return ['Channel #dev successfully registered']; }
      if (body === 'INFO #dev') return registered
        ? ['Channel #dev is registered', 'Founder: ada', 'Registered at: now']
        : ['Channel #dev is not registered'];
      return ['The stored channel history setting is: default'];
    });
    const ctl = make(net);
    const p = ctl.register('#dev');
    await vi.advanceTimersByTimeAsync(200);
    expect(await p).toMatchObject({ kind: 'done' });
    await vi.advanceTimersByTimeAsync(500);
    expect(ctl.channel('#dev').info).toMatchObject({ registered: true, founder: 'ada' });
  });

  it('Ergo transfer replays the confirmation code', async () => {
    const net = fakeNet((_t, body) => body === 'TRANSFER #dev nova'
      ? ['\x02Warning: you are about to transfer control of your channel to another user.\x02', 'To confirm your channel transfer, type: /CS TRANSFER #dev nova 12345']
      : body === 'TRANSFER #dev nova 12345' ? ['Transfer of channel #dev to account nova succeeded, pending acceptance'] : ['Channel #dev is not registered']);
    const ctl = make(net);
    const p = ctl.transfer('#dev', ' nova ');
    await vi.advanceTimersByTimeAsync(300);
    expect(await p).toMatchObject({ kind: 'done', pending: true });
    expect(net.sent.slice(0, 2).map(([, b]) => b)).toEqual(['TRANSFER #dev nova', 'TRANSFER #dev nova 12345']);
  });

  it('collects transfer offers and accepts them', async () => {
    const net = fakeNet((_t, body) => body === 'TRANSFER ACCEPT #dev' ? ['Successfully accepted ownership of channel #dev'] : ['Channel #dev is not registered']);
    const ctl = make(net);
    net.emit({ Kind: 'NOTICE', From: 'ChanServ', Target: 'ada', Message: 'You have been offered ownership of channel #dev. To accept, /CS TRANSFER ACCEPT #dev', Raw: '' });
    expect(ctl.getState().offers).toEqual(['#dev']);
    const p = ctl.acceptTransfer('#dev');
    await vi.advanceTimersByTimeAsync(200);
    expect(await p).toMatchObject({ kind: 'done' });
    expect(ctl.getState().offers).toEqual([]);
  });

  it('refreshes a channel when its founder mode moves, and everything on login', async () => {
    let n = 0;
    const net = fakeNet((_t, body) => (body.startsWith('INFO') ? (n++, ['Channel #dev is not registered']) : null));
    const ctl = make(net);
    ctl.ensureInfo('#dev');
    await vi.advanceTimersByTimeAsync(200);
    expect(n).toBe(1);
    net.emit({ Kind: 'MODE', From: 'ChanServ', Target: '#dev', Message: '', Args: ['+q', 'ada'], Raw: '' });
    await vi.advanceTimersByTimeAsync(200);
    expect(n).toBe(2);
    net.emit({ Kind: 'MODE', From: 'nova', Target: '#dev', Message: '', Args: ['+v', 'pixel'], Raw: '' });
    await vi.advanceTimersByTimeAsync(200);
    expect(n).toBe(2);
    net.emit({ Kind: '900', From: 'irc.test', Target: 'ada', Message: 'You are now logged in as ada', Raw: '' });
    await vi.advanceTimersByTimeAsync(200);
    expect(n).toBe(3);
  });

  it('applies a toggled option at once', async () => {
    signals = { framework: 'atheme' };
    let guard = false;
    const net = fakeNet((_t, body) => {
      if (body.startsWith('SET')) { guard = true; return ['The \x02GUARD\x02 flag has been set for channel \x02#dev\x02.']; }
      return ['Information on \x02#dev\x02:', 'Founder    : ada', 'Registered : Nov 14 10:00:00 2026 +0000 (1d ago)',
        ...(guard ? ['Flags      : GUARD'] : []), '\x02*** End of Info ***\x02'];
    });
    const ctl = make(net);
    ctl.ensureInfo('#dev');
    await vi.advanceTimersByTimeAsync(200);
    expect(ctl.channel('#dev').info?.options).toEqual({});
    const p = ctl.setOption('#dev', 'guard', true);
    await vi.advanceTimersByTimeAsync(20);
    expect(await p).toMatchObject({ kind: 'done' });
    expect(ctl.channel('#dev').info?.options).toEqual({ guard: true });
    await vi.advanceTimersByTimeAsync(200);
    expect(ctl.channel('#dev').info?.options).toEqual({ guard: true });
    expect(net.sent.map(([, b]) => b)).toContain('SET #dev GUARD ON');
  });

  it('claims background replies so they stay out of the Server log', async () => {
    const net = fakeNet(() => ['Channel #dev is not registered']);
    const ctl = make(net);
    const seen: boolean[] = [];
    net.attach((e) => { ctl.handleEvent(e); seen.push(ctl.claims(e)); });
    ctl.ensureInfo('#dev');
    await vi.advanceTimersByTimeAsync(200);
    expect(seen).toEqual([true]);
    const stray: IrcEvent = { Kind: 'NOTICE', From: 'ChanServ', Target: 'ada', Message: 'hello', Raw: '' };
    ctl.handleEvent(stray);
    expect(ctl.claims(stray)).toBe(false);
  });
});
