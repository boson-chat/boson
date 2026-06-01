import { describe, it, expect, vi } from 'vitest';
import { AnopeAccountService } from './account-service-anope';
import { AthemeAccountService } from './account-service-atheme';
import { ErgoAccountService } from './account-service-ergo';
import { classifyResendReply } from './account-service-helpers';
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

describe('classifyResendReply', () => {
  const sentCases = [
    { body: 'The confirmation code for alice has been re-sent to alice@example.com.', label: 'anope re-sent hyphenated' },
    { body: 'The confirmation code for alice has been resent to alice@example.com.', label: 'anope resent unhyphenated' },
    { body: 'Your activation email has been re-sent.', label: 'generic email re-sent' },
  ];
  for (const tc of sentCases) {
    it(`${tc.label} → sent`, () => {
      expect(classifyResendReply(tc.body)).toEqual({ kind: 'sent' });
    });
  }

  it('"Cannot send mail now; please retry a little later." → cooldown with 5-min retry', () => {
    const result = classifyResendReply('Cannot send mail now; please retry a little later.');
    expect(result?.kind).toBe('cooldown');
    if (result?.kind === 'cooldown') {
      expect(result.retryAfterMs).toBe(5 * 60 * 1000);
    }
  });

  it('"please retry a little later" (alternate phrasing) → cooldown', () => {
    const result = classifyResendReply('Please retry a little later.');
    expect(result?.kind).toBe('cooldown');
  });

  it('"Email could not be sent" → failed', () => {
    const result = classifyResendReply('Email could not be sent: SMTP unreachable.');
    expect(result?.kind).toBe('failed');
  });

  it('"Mail is not configured" → failed', () => {
    const result = classifyResendReply('Mail is not configured on this server.');
    expect(result?.kind).toBe('failed');
  });

  it('returns null for non-terminal replies', () => {
    expect(classifyResendReply('Welcome to the network.')).toBeNull();
    expect(classifyResendReply('')).toBeNull();
  });
});

describe('AnopeAccountService.resend', () => {
  it('fires bare RESEND (no account name arg, since it\'s oper-only on most builds)', async () => {
    const { session, sent, pushEvent } = makeFakeSession();
    const svc = new AnopeAccountService(session, { myNick: 'Nyan' });

    void svc.resend('Nyan');
    await Promise.resolve();

    expect(sent).toEqual([{ target: 'NickServ', message: 'RESEND' }]);
    pushEvent({ Message: 'The confirmation code for Nyan has been re-sent to alice@example.com.' });
  });

  it('resolves sent on Anope success reply', async () => {
    const { session, pushEvent } = makeFakeSession();
    const svc = new AnopeAccountService(session, { myNick: 'Nyan' });

    const promise = svc.resend('Nyan');
    pushEvent({ Message: 'The confirmation code for Nyan has been re-sent to alice@example.com.' });

    expect(await promise).toEqual({ kind: 'sent' });
  });

  it('resolves cooldown with 5-minute retry on rate-limit reply', async () => {
    const { session, pushEvent } = makeFakeSession();
    const svc = new AnopeAccountService(session, { myNick: 'Nyan' });

    const promise = svc.resend('Nyan');
    pushEvent({ Message: 'Cannot send mail now; please retry a little later.' });

    const result = await promise;
    expect(result.kind).toBe('cooldown');
    if (result.kind === 'cooldown') {
      expect(result.retryAfterMs).toBe(5 * 60 * 1000);
    }
  });

  it('times out when no reply lands', async () => {
    vi.useFakeTimers();
    const { session } = makeFakeSession();
    const svc = new AnopeAccountService(session, { myNick: 'Nyan', timeoutMs: 3_000 });

    const promise = svc.resend('Nyan');
    await vi.advanceTimersByTimeAsync(3_000);

    expect(await promise).toEqual({ kind: 'failed', reason: 'timeout' });
    vi.useRealTimers();
  });

  it('supportsResend() returns true', () => {
    const { session } = makeFakeSession();
    const svc = new AnopeAccountService(session, { myNick: 'Nyan' });
    expect(svc.supportsResend()).toBe(true);
  });
});

describe('AthemeAccountService.resend', () => {
  it('supportsResend() returns false (Atheme has no resend command)', () => {
    const { session } = makeFakeSession();
    const svc = new AthemeAccountService(session, { myNick: 'Nyan' });
    expect(svc.supportsResend()).toBe(false);
  });

  it('resend() resolves to unsupported WITHOUT firing any IRC traffic', async () => {
    const { session, sent } = makeFakeSession();
    const svc = new AthemeAccountService(session, { myNick: 'Nyan' });

    const result = await svc.resend('Nyan');

    expect(result).toEqual({ kind: 'unsupported', verb: 'resend' });
    expect(sent).toEqual([]);
  });
});

describe('ErgoAccountService.resend', () => {
  it('supportsResend() returns false', () => {
    const { session } = makeFakeSession();
    const svc = new ErgoAccountService(session, { myNick: 'Nyan' });
    expect(svc.supportsResend()).toBe(false);
  });

  it('resend() resolves to unsupported WITHOUT firing any IRC traffic', async () => {
    const { session, sent } = makeFakeSession();
    const svc = new ErgoAccountService(session, { myNick: 'Nyan' });

    const result = await svc.resend('Nyan');

    expect(result).toEqual({ kind: 'unsupported', verb: 'resend' });
    expect(sent).toEqual([]);
  });
});
