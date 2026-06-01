import { describe, it, expect, vi } from 'vitest';
import { AnopeAccountService } from './account-service-anope';
import { AthemeAccountService } from './account-service-atheme';
import { ErgoAccountService } from './account-service-ergo';
import { classifyIdentifyReply } from './account-service-helpers';
import type { ServerSession } from '../engine/engine.client';
import type { IrcEvent } from '../engine/engine.types';

function makeFakeSession() {
  const listeners = new Set<(e: IrcEvent) => void>();
  const sent: { kind: 'privmsg' | 'nickservIdentify'; target?: string; message: string }[] = [];

  const session = {
    privmsg: (target: string, message: string) => {
      sent.push({ kind: 'privmsg', target, message });
    },
    nickservIdentify: (password: string) => {
      sent.push({ kind: 'nickservIdentify', message: password });
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

describe('classifyIdentifyReply — package-agnostic reply table', () => {
  const successCases = [
    // Atheme
    { body: 'You are now identified for Nyan.', label: 'atheme identified-for' },
    { body: 'You are now logged in as Nyan.', label: 'atheme logged-in-as' },
    { body: 'You are already logged in as Nyan.', label: 'atheme already-logged-in' },
    // Anope
    { body: 'Password accepted - you are now recognized.', label: 'anope password-accepted' },
    { body: 'You are already identified.', label: 'anope already-identified' },
    // Ergo
    { body: "You're now logged in as Nyan", label: 'ergo logged-in-as' },
    { body: "You're already logged into an account", label: 'ergo already-logged-in' },
  ];
  for (const tc of successCases) {
    it(`${tc.label} → identified`, () => {
      expect(classifyIdentifyReply(tc.body)).toEqual({ kind: 'identified' });
    });
  }

  const wrongPwCases = [
    { body: 'Invalid password for Nyan.', label: 'atheme invalid-password' },
    { body: 'Password incorrect.', label: 'anope password-incorrect' },
    { body: 'Authentication failed: Invalid account credentials', label: 'ergo authentication-failed' },
  ];
  for (const tc of wrongPwCases) {
    it(`${tc.label} → wrong-password`, () => {
      expect(classifyIdentifyReply(tc.body)).toEqual({ kind: 'wrong-password' });
    });
  }

  const noSuchCases = [
    { body: 'Nyan is not a registered nickname.', label: 'atheme not-registered' },
    { body: "Nick Nyan isn't registered.", label: 'anope NICK_X_NOT_REGISTERED' },
    { body: 'Authentication failed: Account does not exist', label: 'ergo account-does-not-exist' },
    { body: 'No such account.', label: 'generic no-such-account' },
    { body: 'No such nick.', label: 'generic no-such-nick' },
  ];
  for (const tc of noSuchCases) {
    it(`${tc.label} → no-such-account`, () => {
      expect(classifyIdentifyReply(tc.body)).toEqual({ kind: 'no-such-account' });
    });
  }

  it('returns null for non-terminal replies (impl should keep waiting)', () => {
    expect(classifyIdentifyReply('Welcome to the network.')).toBeNull();
    expect(classifyIdentifyReply('You have 2 new memos.')).toBeNull();
    expect(classifyIdentifyReply('')).toBeNull();
  });

  it('account-does-not-exist takes priority over authentication-failed when both keywords are present', () => {
    // Ergo's exact phrasing combines both — must classify as
    // no-such-account, not wrong-password. Regression for the
    // ordering invariant in classifyIdentifyReply.
    expect(classifyIdentifyReply('Authentication failed: Account does not exist'))
      .toEqual({ kind: 'no-such-account' });
  });
});

describe('AnopeAccountService.identify', () => {
  it('resolves identified on "Password accepted"', async () => {
    const { session, sent, pushEvent } = makeFakeSession();
    const svc = new AnopeAccountService(session, { myNick: 'Nyan' });

    const promise = svc.identify('hunter2');

    // Uses the dedicated engine path, not raw privmsg.
    expect(sent).toEqual([{ kind: 'nickservIdentify', message: 'hunter2' }]);

    pushEvent({ Message: 'Password accepted - you are now recognized.' });

    expect(await promise).toEqual({ kind: 'identified' });
  });

  it('resolves wrong-password on "Password incorrect."', async () => {
    const { session, pushEvent } = makeFakeSession();
    const svc = new AnopeAccountService(session, { myNick: 'Nyan' });

    const promise = svc.identify('wrong');
    pushEvent({ Message: 'Password incorrect.' });

    expect(await promise).toEqual({ kind: 'wrong-password' });
  });

  it('resolves no-such-account on Anope NICK_X_NOT_REGISTERED', async () => {
    const { session, pushEvent } = makeFakeSession();
    const svc = new AnopeAccountService(session, { myNick: 'Nyan' });

    const promise = svc.identify('hunter2');
    pushEvent({ Message: "Nick Ghost isn't registered." });

    expect(await promise).toEqual({ kind: 'no-such-account' });
  });
});

describe('AthemeAccountService.identify', () => {
  it('resolves identified on "You are now identified for X"', async () => {
    const { session, sent, pushEvent } = makeFakeSession();
    const svc = new AthemeAccountService(session, { myNick: 'Nyan' });

    const promise = svc.identify('hunter2');

    expect(sent).toEqual([{ kind: 'nickservIdentify', message: 'hunter2' }]);

    pushEvent({ Message: 'You are now identified for Nyan.' });

    expect(await promise).toEqual({ kind: 'identified' });
  });

  it('resolves wrong-password on "Invalid password for X"', async () => {
    const { session, pushEvent } = makeFakeSession();
    const svc = new AthemeAccountService(session, { myNick: 'Nyan' });

    const promise = svc.identify('wrong');
    pushEvent({ Message: 'Invalid password for Nyan.' });

    expect(await promise).toEqual({ kind: 'wrong-password' });
  });

  it('resolves no-such-account on "X is not a registered nickname"', async () => {
    const { session, pushEvent } = makeFakeSession();
    const svc = new AthemeAccountService(session, { myNick: 'Nyan' });

    const promise = svc.identify('hunter2');
    pushEvent({ Message: 'Ghost is not a registered nickname.' });

    expect(await promise).toEqual({ kind: 'no-such-account' });
  });
});

describe('ErgoAccountService.identify', () => {
  it("resolves identified on \"You're now logged in as X\"", async () => {
    const { session, sent, pushEvent } = makeFakeSession();
    const svc = new ErgoAccountService(session, { myNick: 'Nyan' });

    const promise = svc.identify('hunter2');

    expect(sent).toEqual([{ kind: 'nickservIdentify', message: 'hunter2' }]);

    pushEvent({ Message: "You're now logged in as Nyan" });

    expect(await promise).toEqual({ kind: 'identified' });
  });

  it('resolves no-such-account on Ergo Account-does-not-exist (priority over auth-failed)', async () => {
    const { session, pushEvent } = makeFakeSession();
    const svc = new ErgoAccountService(session, { myNick: 'Nyan' });

    const promise = svc.identify('hunter2');
    pushEvent({ Message: 'Authentication failed: Account does not exist' });

    expect(await promise).toEqual({ kind: 'no-such-account' });
  });

  it('resolves wrong-password on Ergo Authentication failed: Invalid account credentials', async () => {
    const { session, pushEvent } = makeFakeSession();
    const svc = new ErgoAccountService(session, { myNick: 'Nyan' });

    const promise = svc.identify('wrong');
    pushEvent({ Message: 'Authentication failed: Invalid account credentials' });

    expect(await promise).toEqual({ kind: 'wrong-password' });
  });
});

describe('identify() shared behaviour', () => {
  it('times out when no NickServ reply lands', async () => {
    vi.useFakeTimers();
    const { session } = makeFakeSession();
    const svc = new AnopeAccountService(session, { myNick: 'Nyan', timeoutMs: 3_000 });

    const promise = svc.identify('hunter2');
    await vi.advanceTimersByTimeAsync(3_000);

    expect(await promise).toEqual({ kind: 'failed', reason: 'timeout' });
    vi.useRealTimers();
  });

  it('ignores NOTICEs addressed to other nicks', async () => {
    const { session, pushEvent } = makeFakeSession();
    const svc = new AnopeAccountService(session, { myNick: 'Nyan' });

    const promise = svc.identify('hunter2');

    pushEvent({ Target: 'OtherUser', Message: 'Password accepted - you are now recognized.' });

    let settled = false;
    promise.then(() => { settled = true; });
    await new Promise((r) => setTimeout(r, 10));
    expect(settled).toBe(false);

    pushEvent({ Target: 'Nyan', Message: 'Password accepted - you are now recognized.' });
    expect(await promise).toEqual({ kind: 'identified' });
  });
});
