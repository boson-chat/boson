import { describe, it, expect, vi } from 'vitest';
import { ErgoAccountService } from './account-service-ergo';
import type { ServerSession } from '../engine/engine.client';
import type { IrcEvent } from '../engine/engine.types';

function makeFakeSession() {
  const listeners = new Set<(e: IrcEvent) => void>();
  const sent: { target: string; message: string }[] = [];

  const session = {
    privmsg: (target: string, message: string) => {
      sent.push({ target, message });
    },
    onEvent: (fn: (e: IrcEvent) => void) => {
      listeners.add(fn);
      return () => { listeners.delete(fn); };
    },
  } as unknown as ServerSession;

  return {
    session,
    sent,
    pushEvent: (event: Partial<IrcEvent>): void => {
      const full: IrcEvent = {
        Kind: 'NOTICE',
        From: 'NickServ',
        Target: 'Nyan',
        Message: '',
        Raw: '',
        ...event,
      };
      for (const fn of listeners) fn(full);
    },
  };
}

describe('ErgoAccountService.drop', () => {
  it('fires UNREGISTER (not DROP) on kickoff', async () => {
    const { session, sent } = makeFakeSession();
    const svc = new ErgoAccountService(session, { myNick: 'Nyan' });

    void svc.drop('Nyan', 'hunter2');
    await Promise.resolve();

    expect(sent).toEqual([{ target: 'NickServ', message: 'UNREGISTER Nyan' }]);
  });

  it('ignores the warning NOTICEs Ergo sends before the confirm prompt', async () => {
    const { session, sent, pushEvent } = makeFakeSession();
    const svc = new ErgoAccountService(session, { myNick: 'Nyan' });

    void svc.drop('Nyan', 'hunter2');
    await Promise.resolve();

    // Captured-live preamble — none of these should provoke a follow-up.
    pushEvent({ Message: '\x02Warning: unregistering this account will remove its stored privileges.\x02' });
    pushEvent({ Message: '\x02If you are having problems with your account, contact an administrator.\x02' });
    pushEvent({ Message: '\x02Unregistering your account will unregister all channels you founded.\x02' });
    pushEvent({ Message: '\x02Note that an unregistered account name remains reserved and cannot be re-registered.\x02' });
    pushEvent({ Message: '\x02To prevent this, transfer your channels first with CS TRANSFER.\x02' });

    // Still only the initial UNREGISTER on the wire.
    expect(sent).toEqual([{ target: 'NickServ', message: 'UNREGISTER Nyan' }]);
  });

  it('replays the /NS UNREGISTER <token> follow-up verbatim', async () => {
    const { session, sent, pushEvent } = makeFakeSession();
    const svc = new ErgoAccountService(session, { myNick: 'Nyan' });

    const promise = svc.drop('Nyan', 'hunter2');

    pushEvent({ Message: 'To confirm, run this command: /NS UNREGISTER Nyan xjzda' });

    expect(sent).toEqual([
      { target: 'NickServ', message: 'UNREGISTER Nyan' },
      { target: 'NickServ', message: 'UNREGISTER Nyan xjzda' },
    ]);

    pushEvent({ Message: 'Successfully unregistered account Nyan' });

    expect(await promise).toEqual({ kind: 'dropped' });
  });

  it('handles the full captured-live preamble + replay + success in sequence', async () => {
    const { session, sent, pushEvent } = makeFakeSession();
    const svc = new ErgoAccountService(session, { myNick: 'Nyan' });

    const promise = svc.drop('Nyan', 'hunter2');

    // Full preamble.
    pushEvent({ Message: 'Warning: unregistering this account will remove its stored privileges.' });
    pushEvent({ Message: 'If you are having problems with your account, contact an administrator.' });
    pushEvent({ Message: 'Unregistering your account will unregister all channels you founded.' });
    pushEvent({ Message: 'Note that an unregistered account name remains reserved and cannot be re-registered.' });
    pushEvent({ Message: 'To prevent this, transfer your channels first with CS TRANSFER.' });
    // Final confirm prompt.
    pushEvent({ Message: 'To confirm, run this command: /NS UNREGISTER Nyan xjzda' });
    // Success.
    pushEvent({ Message: 'Successfully unregistered account Nyan' });

    expect(await promise).toEqual({ kind: 'dropped' });
    expect(sent.map((s) => s.message)).toEqual([
      'UNREGISTER Nyan',
      'UNREGISTER Nyan xjzda',
    ]);
  });

  it('resolves no-such-account on "Account does not exist"', async () => {
    const { session, pushEvent } = makeFakeSession();
    const svc = new ErgoAccountService(session, { myNick: 'Nyan' });

    const promise = svc.drop('Ghost', 'pw');

    pushEvent({ Message: 'Authentication failed: Account does not exist' });

    // Account-does-not-exist takes priority — checked before
    // generic authentication-failed (which would map to wrong-password).
    expect(await promise).toEqual({ kind: 'no-such-account' });
  });

  it('resolves wrong-password on generic Authentication failed', async () => {
    const { session, pushEvent } = makeFakeSession();
    const svc = new ErgoAccountService(session, { myNick: 'Nyan' });

    const promise = svc.drop('Nyan', 'pw');

    pushEvent({ Message: 'Authentication failed: Invalid account credentials' });

    expect(await promise).toEqual({ kind: 'wrong-password' });
  });

  it('times out when server never replies', async () => {
    vi.useFakeTimers();
    const { session } = makeFakeSession();
    const svc = new ErgoAccountService(session, { myNick: 'Nyan', timeoutMs: 3_000 });

    const promise = svc.drop('Nyan', 'hunter2');
    await vi.advanceTimersByTimeAsync(3_000);

    expect(await promise).toEqual({ kind: 'failed', reason: 'timeout' });
    vi.useRealTimers();
  });

  it('does NOT replay on info notices mentioning /NS or /msg NickServ (regression)', async () => {
    const { session, sent, pushEvent } = makeFakeSession();
    const svc = new ErgoAccountService(session, { myNick: 'Nyan' });

    void svc.drop('Nyan', 'hunter2');
    await Promise.resolve();

    pushEvent({ Message: 'If you need help, reply with /NS HELP for more info.' });
    pushEvent({ Message: 'To list channels, type /msg NickServ LISTCHANS' });

    // Initial UNREGISTER only — no false-positive replays.
    expect(sent).toEqual([{ target: 'NickServ', message: 'UNREGISTER Nyan' }]);
  });
});

describe('ErgoAccountService capabilities', () => {
  it('supportsResend() returns false (no upstream resend in default builds)', () => {
    const { session } = makeFakeSession();
    const svc = new ErgoAccountService(session, { myNick: 'Nyan' });
    expect(svc.supportsResend()).toBe(false);
  });

  it('resend() resolves to {kind:"unsupported"}', async () => {
    const { session } = makeFakeSession();
    const svc = new ErgoAccountService(session, { myNick: 'Nyan' });
    expect(await svc.resend('Nyan')).toEqual({ kind: 'unsupported', verb: 'resend' });
  });
});
