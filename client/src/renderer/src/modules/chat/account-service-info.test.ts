import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import type { IrcEvent } from '../engine/engine.types';
import type { ServerSession } from '../engine/engine.client';
import { classifyInfoReply } from './account-service-helpers';
import { AnopeAccountService } from './account-service-anope';

// Mirrors the fake session used by the other account-service tests:
// pushEvent defaults to a NickServ NOTICE addressed to 'Nyan'.
function makeFakeSession() {
  const listeners = new Set<(e: IrcEvent) => void>();
  const sent: { target: string; message: string }[] = [];

  const session = {
    privmsg: (target: string, message: string) => { sent.push({ target, message }); },
    nickservIdentify: (_pw: string) => { /* unused for info tests */ },
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

describe('classifyInfoReply — Anope INFO block parsing', () => {
  it('"Nick Nyan isn\'t registered." → registered:false', () => {
    expect(classifyInfoReply("Nick Nyan isn't registered.", 'Nyan')).toEqual({
      accountName: 'Nyan',
      registered: false,
      rawBody: "Nick Nyan isn't registered.",
    });
  });

  it('real irc.boson.chat unconfirmed block → registered + confirmed:false + email + name', () => {
    // Verbatim from the wire capture (order as received).
    const body = [
      'Nyan2 is Nyan2',
      'Account: Nyan2',
      'Nyan2 is an unconfirmed nickname.',
      'Online from: Nyan2@162.245.68.70',
      'Registered: Jun 12 00:42:05 2026 UTC (5 seconds ago)',
      'Email address: reg-b2f6ac8d377f4ce688b957fd357c2700-tn45fdoa@boson.chat',
      'Expires: Jun 13 00:42:05 2026 UTC (23 hours, 59 minutes from now)',
      'Options: Private, Protection, Security, Auto-op',
    ].join('\n');

    const info = classifyInfoReply(body, 'Nyan2');
    expect(info.registered).toBe(true);
    expect(info.confirmed).toBe(false);
    expect(info.accountName).toBe('Nyan2');
    expect(info.email).toBe('reg-b2f6ac8d377f4ce688b957fd357c2700-tn45fdoa@boson.chat');
    expect(info.registeredAt).toBe(Date.parse('Jun 12 00:42:05 2026 UTC'));
  });

  it('registered block with no unconfirmed marker → confirmed:true', () => {
    const body = [
      'Account: Nyan',
      'Online from: Nyan@host',
      'Registered: Jun 01 12:00:00 2026 UTC',
      'Options: Security',
    ].join('\n');
    const info = classifyInfoReply(body, 'Nyan');
    expect(info.registered).toBe(true);
    expect(info.confirmed).toBe(true);
  });

  it('empty body → registered undefined (couldn\'t determine)', () => {
    expect(classifyInfoReply('', 'Nyan')).toEqual({ accountName: 'Nyan', rawBody: '' });
  });
});

describe('AnopeAccountService.info — runInfo accumulation', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('fires INFO <nick> as a raw privmsg', () => {
    const { session, sent } = makeFakeSession();
    const svc = new AnopeAccountService(session, { myNick: 'Nyan' });
    void svc.info('Nyan2');
    expect(sent).toEqual([{ target: 'NickServ', message: 'INFO Nyan2' }]);
  });

  it('accumulates the multi-line block and settles into a parsed AccountInfo', async () => {
    const { session, pushEvent } = makeFakeSession();
    const svc = new AnopeAccountService(session, { myNick: 'Nyan' });

    const promise = svc.info('Nyan');
    pushEvent({ Message: 'Account: Nyan' });
    pushEvent({ Message: 'Nyan is an unconfirmed nickname.' });
    pushEvent({ Message: 'Email address: reg-x@boson.chat' });

    // No new lines for the settle window → resolves.
    await vi.advanceTimersByTimeAsync(700);
    const info = await promise;
    expect(info.registered).toBe(true);
    expect(info.confirmed).toBe(false);
    expect(info.email).toBe('reg-x@boson.chat');
  });

  it('resolves early (no settle wait) on "isn\'t registered"', async () => {
    const { session, pushEvent } = makeFakeSession();
    const svc = new AnopeAccountService(session, { myNick: 'Nyan' });

    const promise = svc.info('Ghost');
    pushEvent({ Message: "Nick Ghost isn't registered." });

    // Resolve without advancing the settle timer at all.
    const info = await promise;
    expect(info).toEqual({ accountName: 'Ghost', registered: false, rawBody: "Nick Ghost isn't registered." });
  });

  it('hard-times-out with registered undefined when the server never replies', async () => {
    const { session } = makeFakeSession();
    const svc = new AnopeAccountService(session, { myNick: 'Nyan', timeoutMs: 5000 });

    const promise = svc.info('Nyan');
    await vi.advanceTimersByTimeAsync(5000);
    const info = await promise;
    expect(info.registered).toBeUndefined();
  });
});
