import { describe, it, expect, vi } from 'vitest';
import { OperationGuard } from './account-service-helpers';
import { AnopeAccountService } from './account-service-anope';
import { AthemeAccountService } from './account-service-atheme';
import { ErgoAccountService } from './account-service-ergo';
import type { ServerSession } from '../engine/engine.client';

describe('OperationGuard.dedupe', () => {
  it('returns the same promise for concurrent calls with the same key', async () => {
    const guard = new OperationGuard();
    const factory = vi.fn().mockImplementation(
      () => new Promise<string>((resolve) => setTimeout(() => resolve('done'), 50)),
    );

    const p1 = guard.dedupe('op', factory);
    const p2 = guard.dedupe('op', factory);

    expect(p1).toBe(p2);
    expect(factory).toHaveBeenCalledOnce();
    expect(await p1).toBe('done');
    expect(await p2).toBe('done');
  });

  it('allows a fresh call after the previous one resolves', async () => {
    const guard = new OperationGuard();
    let calls = 0;
    const factory = vi.fn().mockImplementation(() => {
      calls++;
      return Promise.resolve(`call-${calls}`);
    });

    expect(await guard.dedupe('op', factory)).toBe('call-1');
    // First promise has settled; second call should re-run the factory.
    expect(await guard.dedupe('op', factory)).toBe('call-2');
    expect(factory).toHaveBeenCalledTimes(2);
  });

  it('allows a fresh call after the previous one rejects', async () => {
    const guard = new OperationGuard();
    const factory = vi.fn()
      .mockImplementationOnce(() => Promise.reject(new Error('boom')))
      .mockImplementationOnce(() => Promise.resolve('ok'));

    await expect(guard.dedupe('op', factory)).rejects.toThrow('boom');
    expect(await guard.dedupe('op', factory)).toBe('ok');
  });

  it('different keys run independently in parallel', async () => {
    const guard = new OperationGuard();
    let aResolve!: (v: string) => void;
    let bResolve!: (v: string) => void;
    const factoryA = () => new Promise<string>((r) => { aResolve = r; });
    const factoryB = () => new Promise<string>((r) => { bResolve = r; });

    const pA = guard.dedupe('a', factoryA);
    const pB = guard.dedupe('b', factoryB);

    bResolve('b-result');
    aResolve('a-result');

    expect(await pA).toBe('a-result');
    expect(await pB).toBe('b-result');
  });
});

// Helper: build a fake session that ignores wire traffic (we're
// testing dedupe, not the reply classification).
function makeSilentSession() {
  const sent: { target: string; message: string }[] = [];
  const session = {
    privmsg: (target: string, message: string) => { sent.push({ target, message }); },
    nickservIdentify: (_pw: string) => { /* noop */ },
    onEvent: () => () => { /* noop */ },
  } as unknown as ServerSession;
  return { session, sent };
}

describe('AccountService impls — in-flight dedupe (no double-fire on the wire)', () => {
  it('AnopeAccountService.drop dedupes concurrent calls', () => {
    const { session, sent } = makeSilentSession();
    const svc = new AnopeAccountService(session, { myNick: 'Nyan' });

    // Two concurrent drops — should fire only ONE DROP on the wire.
    void svc.drop('Nyan', 'pw');
    void svc.drop('Nyan', 'pw');

    expect(sent).toEqual([{ target: 'NickServ', message: 'DROP Nyan' }]);
  });

  it('AthemeAccountService.drop dedupes concurrent calls (the canonical hazard)', () => {
    const { session, sent } = makeSilentSession();
    const svc = new AthemeAccountService(session, { myNick: 'Nyan' });

    // The reason for OperationGuard's existence: Atheme issues a
    // single server-side key per drop session. A duplicate replay
    // sends a stale key → "Invalid key for DROP". The guard prevents
    // the second wire-level DROP from going out at all.
    void svc.drop('Nyan', 'pw');
    void svc.drop('Nyan', 'pw');

    expect(sent).toEqual([{ target: 'NickServ', message: 'DROP Nyan pw' }]);
  });

  it('ErgoAccountService.drop dedupes concurrent calls', () => {
    const { session, sent } = makeSilentSession();
    const svc = new ErgoAccountService(session, { myNick: 'Nyan' });

    void svc.drop('Nyan', 'pw');
    void svc.drop('Nyan', 'pw');

    expect(sent).toEqual([{ target: 'NickServ', message: 'UNREGISTER Nyan' }]);
  });

  it('different operations on the same service run in parallel (dedupe is per-op)', () => {
    const { session, sent } = makeSilentSession();
    const svc = new AnopeAccountService(session, { myNick: 'Nyan' });

    void svc.drop('Nyan', 'pw');
    void svc.confirm('Nyan', 'abc123');

    // Drop and confirm both fired their initial commands — keys are
    // independent ('drop' vs 'confirm'), so the guard doesn't merge them.
    expect(sent).toEqual([
      { target: 'NickServ', message: 'DROP Nyan' },
      { target: 'NickServ', message: 'CONFIRM abc123' },
    ]);
  });
});
