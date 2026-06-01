import { describe, it, expect, vi } from 'vitest';
import { AnopeAccountService } from './account-service-anope';
import { AthemeAccountService } from './account-service-atheme';
import { ErgoAccountService } from './account-service-ergo';
import { classifyConfirmReply } from './account-service-helpers';
import type { ServerSession } from '../engine/engine.client';
import type { IrcEvent } from '../engine/engine.types';

function makeFakeSession() {
  const listeners = new Set<(e: IrcEvent) => void>();
  const sent: { target: string; message: string }[] = [];

  const session = {
    privmsg: (target: string, message: string) => { sent.push({ target, message }); },
    nickservIdentify: (_pw: string) => { /* unused */ },
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

describe('classifyConfirmReply — package-agnostic reply table', () => {
  const confirmedCases = [
    { body: 'Your email address of alice@example.com has been confirmed.', label: 'anope email-confirmed' },
    { body: 'Your account is now confirmed.', label: 'anope account-now-confirmed' },
    { body: 'Email verification complete.', label: 'generic verification-complete' },
    { body: 'Thank you for verifying your e-mail address!', label: 'atheme thank-you' },
    { body: 'Nyan has now been verified.', label: 'atheme has-been-verified' },
    { body: 'Account successfully registered.', label: 'ergo successfully-registered' },
    { body: 'Account successfully verified.', label: 'ergo successfully-verified' },
  ];
  for (const tc of confirmedCases) {
    it(`${tc.label} → confirmed`, () => {
      expect(classifyConfirmReply(tc.body)).toEqual({ kind: 'confirmed' });
    });
  }

  const wrongCodeCases = [
    { body: 'Invalid passcode.', label: 'anope invalid-passcode' },
    { body: 'Verification failed. Invalid key for VERIFY.', label: 'atheme verification-failed' },
    { body: 'Incorrect passcode.', label: 'generic incorrect-passcode' },
    { body: 'Invalid verification code.', label: 'generic invalid-code' },
    { body: 'Account verification failed: code mismatch', label: 'ergo code-mismatch' },
  ];
  for (const tc of wrongCodeCases) {
    it(`${tc.label} → wrong-code`, () => {
      expect(classifyConfirmReply(tc.body)).toEqual({ kind: 'wrong-code' });
    });
  }

  const expiredCases = [
    { body: 'Verification code has expired.', label: 'expired generic' },
    { body: 'Nyan is not awaiting verification.', label: 'atheme not-awaiting' },
    { body: 'This code is no longer valid.', label: 'no-longer-valid' },
    { body: 'No longer pending verification.', label: 'no-longer-pending' },
  ];
  for (const tc of expiredCases) {
    it(`${tc.label} → expired`, () => {
      expect(classifyConfirmReply(tc.body)).toEqual({ kind: 'expired' });
    });
  }

  it('returns null for non-terminal replies', () => {
    expect(classifyConfirmReply('Welcome to the network.')).toBeNull();
    expect(classifyConfirmReply('')).toBeNull();
  });
});

describe('AnopeAccountService.confirm', () => {
  it('fires CONFIRM <code> (no account name on the wire)', async () => {
    const { session, sent, pushEvent } = makeFakeSession();
    const svc = new AnopeAccountService(session, { myNick: 'Nyan' });

    void svc.confirm('Nyan', 'ab12cd34');
    await Promise.resolve();

    expect(sent).toEqual([{ target: 'NickServ', message: 'CONFIRM ab12cd34' }]);
    // Drain.
    pushEvent({ Message: 'Your account is now confirmed.' });
  });

  it('resolves confirmed on Anope success reply', async () => {
    const { session, pushEvent } = makeFakeSession();
    const svc = new AnopeAccountService(session, { myNick: 'Nyan' });

    const promise = svc.confirm('Nyan', 'ab12cd34');
    pushEvent({ Message: 'Your email address of alice@example.com has been confirmed.' });

    expect(await promise).toEqual({ kind: 'confirmed' });
  });

  it('resolves wrong-code on Anope invalid-passcode', async () => {
    const { session, pushEvent } = makeFakeSession();
    const svc = new AnopeAccountService(session, { myNick: 'Nyan' });

    const promise = svc.confirm('Nyan', 'wrong');
    pushEvent({ Message: 'Invalid passcode.' });

    expect(await promise).toEqual({ kind: 'wrong-code' });
  });
});

describe('AthemeAccountService.confirm', () => {
  it('fires VERIFY REGISTER <acct> <code> with the operation keyword', async () => {
    const { session, sent } = makeFakeSession();
    const svc = new AthemeAccountService(session, { myNick: 'Nyan' });

    void svc.confirm('Nyan', 'ab12cd34');
    await Promise.resolve();

    expect(sent).toEqual([{
      target: 'NickServ',
      message: 'VERIFY REGISTER Nyan ab12cd34',
    }]);
  });

  it('falls back to VERIFY REGISTER <code> when account name is empty', async () => {
    const { session, sent } = makeFakeSession();
    const svc = new AthemeAccountService(session, { myNick: 'Nyan' });

    void svc.confirm('', 'ab12cd34');
    await Promise.resolve();

    expect(sent).toEqual([{
      target: 'NickServ',
      message: 'VERIFY REGISTER ab12cd34',
    }]);
  });

  it('resolves confirmed on "has now been verified"', async () => {
    const { session, pushEvent } = makeFakeSession();
    const svc = new AthemeAccountService(session, { myNick: 'Nyan' });

    const promise = svc.confirm('Nyan', 'ab12cd34');
    pushEvent({ Message: 'Nyan has now been verified.' });

    expect(await promise).toEqual({ kind: 'confirmed' });
  });

  it('resolves expired on "is not awaiting verification"', async () => {
    const { session, pushEvent } = makeFakeSession();
    const svc = new AthemeAccountService(session, { myNick: 'Nyan' });

    const promise = svc.confirm('Nyan', 'stale');
    pushEvent({ Message: 'Nyan is not awaiting verification.' });

    expect(await promise).toEqual({ kind: 'expired' });
  });
});

describe('ErgoAccountService.confirm', () => {
  it('fires VERIFY <acct> <code> WITHOUT the REGISTER keyword (distinguishes from Atheme)', async () => {
    const { session, sent } = makeFakeSession();
    const svc = new ErgoAccountService(session, { myNick: 'Nyan' });

    void svc.confirm('Nyan', 'ab12cd34');
    await Promise.resolve();

    expect(sent).toEqual([{
      target: 'NickServ',
      message: 'VERIFY Nyan ab12cd34',
    }]);
  });

  it('resolves confirmed on Ergo success', async () => {
    const { session, pushEvent } = makeFakeSession();
    const svc = new ErgoAccountService(session, { myNick: 'Nyan' });

    const promise = svc.confirm('Nyan', 'ab12cd34');
    pushEvent({ Message: 'Account successfully registered.' });

    expect(await promise).toEqual({ kind: 'confirmed' });
  });
});

describe('confirm() shared behaviour', () => {
  it('times out when no terminal reply arrives', async () => {
    vi.useFakeTimers();
    const { session } = makeFakeSession();
    const svc = new AnopeAccountService(session, { myNick: 'Nyan', timeoutMs: 3_000 });

    const promise = svc.confirm('Nyan', 'ab12');
    await vi.advanceTimersByTimeAsync(3_000);

    expect(await promise).toEqual({ kind: 'failed', reason: 'timeout' });
    vi.useRealTimers();
  });
});
