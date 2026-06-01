import { describe, it, expect, vi } from 'vitest';
import { AnopeAccountService } from './account-service-anope';
import { AthemeAccountService } from './account-service-atheme';
import { ErgoAccountService } from './account-service-ergo';
import { classifyRegisterReply } from './account-service-helpers';
import type { ServerSession } from '../engine/engine.client';
import type { IrcEvent } from '../engine/engine.types';

function makeFakeSession() {
  const listeners = new Set<(e: IrcEvent) => void>();
  const sent: { target: string; message: string }[] = [];

  const session = {
    privmsg: (target: string, message: string) => { sent.push({ target, message }); },
    nickservIdentify: (_pw: string) => { /* unused for register tests */ },
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

describe('classifyRegisterReply — package-agnostic reply table', () => {
  const email = 'alice@example.com';

  const pendingCases = [
    { body: 'Please type "/msg NickServ CONFIRM ab12cd34" to confirm your account.', label: 'anope CONFIRM prompt' },
    { body: 'Please type "/msg NickServ VERIFY REGISTER alice ab12" to verify.', label: 'atheme VERIFY REGISTER prompt' },
    { body: 'An email containing nickname activation instructions has been sent to alice@example.com.', label: 'atheme activation instructions' },
    { body: 'Account created, pending verification; verification code has been sent to alice@example.com', label: 'ergo pending verification' },
    { body: 'Please verify your email address.', label: 'generic verify-email' },
    { body: 'Check your email for the activation code.', label: 'generic check-your-email' },
  ];
  for (const tc of pendingCases) {
    it(`${tc.label} → pending-confirmation (echoes email)`, () => {
      expect(classifyRegisterReply(tc.body, email)).toEqual({ kind: 'pending-confirmation', email });
    });
  }

  const registeredCases = [
    { body: 'Nickname Nyan has been registered.', label: 'anope has-been-registered' },
    { body: 'Nyan is now registered to alice@example.com.', label: 'atheme is-now-registered-to' },
    { body: 'Account created', label: 'ergo account-created (no-confirm)' },
    { body: 'Successfully registered.', label: 'generic successfully-registered' },
  ];
  for (const tc of registeredCases) {
    it(`${tc.label} → registered`, () => {
      expect(classifyRegisterReply(tc.body, email)).toEqual({ kind: 'registered' });
    });
  }

  it('Ergo "Account created, pending verification" lands pending-confirmation, NOT registered (priority)', () => {
    // Regression: the bare "account created" pattern catches Ergo's
    // no-confirm flow, but pending-verification must take priority
    // when both phrases are present. Same kind of priority rule as
    // the Ergo identify Account-does-not-exist vs auth-failed
    // ordering.
    const body = 'Account created, pending verification; verification code has been sent to alice@example.com';
    expect(classifyRegisterReply(body, email)).toEqual({ kind: 'pending-confirmation', email });
  });

  it('"Nickname Nyan is already registered" → nick-taken', () => {
    expect(classifyRegisterReply('Nickname Nyan is already registered.', email))
      .toEqual({ kind: 'nick-taken' });
  });

  it('"Account Nyan is already registered" → nick-taken', () => {
    expect(classifyRegisterReply('Account Nyan is already registered', email))
      .toEqual({ kind: 'nick-taken' });
  });

  it('"Invalid email address" → email-rejected with reason', () => {
    const result = classifyRegisterReply('Invalid email address.', email);
    expect(result?.kind).toBe('email-rejected');
    if (result?.kind === 'email-rejected') expect(result.reason).toMatch(/invalid email/i);
  });

  it('"Email address is already in use" → email-rejected', () => {
    const result = classifyRegisterReply('Email address is already in use', email);
    expect(result?.kind).toBe('email-rejected');
  });

  it('returns null for non-terminal replies (info / preamble)', () => {
    expect(classifyRegisterReply('Welcome to the network.', email)).toBeNull();
    expect(classifyRegisterReply('', email)).toBeNull();
    expect(classifyRegisterReply('You are now connected.', email)).toBeNull();
  });
});

describe('AnopeAccountService.register', () => {
  it('fires REGISTER pw email as a raw privmsg', async () => {
    const { session, sent, pushEvent } = makeFakeSession();
    const svc = new AnopeAccountService(session, { myNick: 'Nyan' });

    void svc.register('hunter2', 'alice@example.com');
    await Promise.resolve();

    expect(sent).toEqual([{ target: 'NickServ', message: 'REGISTER hunter2 alice@example.com' }]);
    // Drain the listener so it doesn't leak between tests.
    pushEvent({ Message: 'Please type "/msg NickServ CONFIRM ab12" to confirm.' });
  });

  it('resolves pending-confirmation on Anope CONFIRM prompt', async () => {
    const { session, pushEvent } = makeFakeSession();
    const svc = new AnopeAccountService(session, { myNick: 'Nyan' });

    const promise = svc.register('hunter2', 'alice@example.com');
    pushEvent({ Message: 'Please type "/msg NickServ CONFIRM ab12cd34" to confirm.' });

    expect(await promise).toEqual({
      kind: 'pending-confirmation',
      email: 'alice@example.com',
    });
  });

  it('resolves registered on no-confirm reply', async () => {
    const { session, pushEvent } = makeFakeSession();
    const svc = new AnopeAccountService(session, { myNick: 'Nyan' });

    const promise = svc.register('hunter2', 'alice@example.com');
    pushEvent({ Message: 'Nickname Nyan has been registered.' });

    expect(await promise).toEqual({ kind: 'registered' });
  });

  it('resolves nick-taken when already registered', async () => {
    const { session, pushEvent } = makeFakeSession();
    const svc = new AnopeAccountService(session, { myNick: 'Nyan' });

    const promise = svc.register('hunter2', 'alice@example.com');
    pushEvent({ Message: 'Nickname Nyan is already registered.' });

    expect(await promise).toEqual({ kind: 'nick-taken' });
  });
});

describe('AthemeAccountService.register', () => {
  it('resolves pending-confirmation on activation-instructions reply', async () => {
    const { session, pushEvent } = makeFakeSession();
    const svc = new AthemeAccountService(session, { myNick: 'Nyan' });

    const promise = svc.register('hunter2', 'alice@example.com');
    pushEvent({ Message: 'An email containing nickname activation instructions has been sent to alice@example.com.' });

    expect(await promise).toEqual({ kind: 'pending-confirmation', email: 'alice@example.com' });
  });

  it('resolves registered on Atheme auth=none no-confirm reply', async () => {
    const { session, pushEvent } = makeFakeSession();
    const svc = new AthemeAccountService(session, { myNick: 'Nyan' });

    const promise = svc.register('hunter2', 'alice@example.com');
    pushEvent({ Message: 'Nyan is now registered to alice@example.com.' });

    expect(await promise).toEqual({ kind: 'registered' });
  });
});

describe('ErgoAccountService.register', () => {
  it('resolves pending-confirmation on "Account created, pending verification"', async () => {
    const { session, pushEvent } = makeFakeSession();
    const svc = new ErgoAccountService(session, { myNick: 'Nyan' });

    const promise = svc.register('hunter2', 'alice@example.com');
    pushEvent({ Message: 'Account created, pending verification; verification code has been sent to alice@example.com' });

    expect(await promise).toEqual({ kind: 'pending-confirmation', email: 'alice@example.com' });
  });

  it('resolves registered on bare "Account created" (Ergo no-confirm)', async () => {
    const { session, pushEvent } = makeFakeSession();
    const svc = new ErgoAccountService(session, { myNick: 'Nyan' });

    const promise = svc.register('hunter2', 'alice@example.com');
    pushEvent({ Message: 'Account created' });

    expect(await promise).toEqual({ kind: 'registered' });
  });
});

describe('register() shared behaviour', () => {
  it('times out when no terminal reply arrives', async () => {
    vi.useFakeTimers();
    const { session } = makeFakeSession();
    const svc = new AnopeAccountService(session, { myNick: 'Nyan', timeoutMs: 3_000 });

    const promise = svc.register('hunter2', 'alice@example.com');
    await vi.advanceTimersByTimeAsync(3_000);

    expect(await promise).toEqual({ kind: 'failed', reason: 'timeout' });
    vi.useRealTimers();
  });

  it('ignores preamble / info notices and waits for a terminal classification', async () => {
    const { session, pushEvent } = makeFakeSession();
    const svc = new AnopeAccountService(session, { myNick: 'Nyan' });

    const promise = svc.register('hunter2', 'alice@example.com');

    // Random preamble — none should resolve the promise.
    pushEvent({ Message: 'NickServ allows you to register a nickname.' });
    pushEvent({ Message: 'Your hostmask is recorded.' });

    let settled = false;
    promise.then(() => { settled = true; });
    await new Promise((r) => setTimeout(r, 10));
    expect(settled).toBe(false);

    pushEvent({ Message: 'Nickname Nyan has been registered.' });
    expect(await promise).toEqual({ kind: 'registered' });
  });
});
