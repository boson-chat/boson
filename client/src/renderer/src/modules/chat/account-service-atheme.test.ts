import { describe, it, expect, vi } from 'vitest';
import { AthemeAccountService } from './account-service-atheme';
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

describe('AthemeAccountService.drop', () => {
  it('fires the 2-arg DROP on kickoff (Atheme requires both)', async () => {
    const { session, sent } = makeFakeSession();
    const svc = new AthemeAccountService(session, { myNick: 'Nyan' });

    void svc.drop('Nyan', 'hunter2');
    await Promise.resolve();

    expect(sent).toEqual([{ target: 'NickServ', message: 'DROP Nyan hunter2' }]);
  });

  it('replays the inline KEY command verbatim on Libera-style two-step prompt', async () => {
    const { session, sent, pushEvent } = makeFakeSession();
    const svc = new AthemeAccountService(session, { myNick: 'Nyan' });

    const promise = svc.drop('Nyan', 'hunter2');

    // Libera Atheme drop.c:78 — exact phrasing of the two-step prompt.
    pushEvent({
      Message: 'To complete the drop of \x02Nyan\x02, you must reply with: \x02/msg NickServ DROP Nyan ab12cd34ef\x02',
    });

    // Impl auto-fires the EXACT inline command — note KEY, NOT password.
    expect(sent).toEqual([
      { target: 'NickServ', message: 'DROP Nyan hunter2' },           // initial
      { target: 'NickServ', message: 'DROP Nyan ab12cd34ef' },        // KEY replay
    ]);

    pushEvent({ Message: 'The account \x02Nyan\x02 has been dropped.' });

    expect(await promise).toEqual({ kind: 'dropped' });
  });

  it('replays the inline command on dockerised Atheme 3-arg token variant', async () => {
    const { session, sent, pushEvent } = makeFakeSession();
    const svc = new AthemeAccountService(session, { myNick: 'Nyan' });

    const promise = svc.drop('Nyan', 'hunter2');

    // Docker Atheme 7.2.x emits this phrasing; the inline command has
    // 3 args (acct + pw + token) instead of 2 (acct + key).
    pushEvent({
      Message: 'To avoid accidental use of this command, this operation has to be confirmed. Please confirm by replying with \x02/msg NickServ DROP Nyan hunter2 1b4fc401:664c8114\x02',
    });

    expect(sent[1]).toEqual({
      target: 'NickServ',
      message: 'DROP Nyan hunter2 1b4fc401:664c8114',
    });

    pushEvent({ Message: 'The account Nyan has been dropped.' });
    expect(await promise).toEqual({ kind: 'dropped' });
  });

  it('resolves {kind:"failed", reason:"invalid-key"} on wrong KEY follow-up', async () => {
    const { session, pushEvent } = makeFakeSession();
    const svc = new AthemeAccountService(session, { myNick: 'Nyan' });

    const promise = svc.drop('Nyan', 'hunter2');

    // Hypothetically the user typed the wrong follow-up manually,
    // or our extraction misfired and we sent the password as a key.
    pushEvent({ Message: 'Invalid key for DROP.' });

    expect(await promise).toEqual({ kind: 'failed', reason: 'invalid-key' });
  });

  it('resolves {kind:"wrong-password"} on first-step Authentication failed', async () => {
    const { session, pushEvent } = makeFakeSession();
    const svc = new AthemeAccountService(session, { myNick: 'Nyan' });

    const promise = svc.drop('Nyan', 'wrong-pw');

    pushEvent({ Message: 'Authentication failed. Invalid password for Nyan.' });

    expect(await promise).toEqual({ kind: 'wrong-password' });
  });

  it('resolves {kind:"no-such-account"} on Atheme "is not registered"', async () => {
    const { session, pushEvent } = makeFakeSession();
    const svc = new AthemeAccountService(session, { myNick: 'Nyan' });

    const promise = svc.drop('Ghost', 'hunter2');

    pushEvent({ Message: '\x02Ghost\x02 is not registered.' });

    expect(await promise).toEqual({ kind: 'no-such-account' });
  });

  it('times out when server never replies', async () => {
    vi.useFakeTimers();
    const { session } = makeFakeSession();
    const svc = new AthemeAccountService(session, { myNick: 'Nyan', timeoutMs: 3_000 });

    const promise = svc.drop('Nyan', 'hunter2');

    await vi.advanceTimersByTimeAsync(3_000);

    expect(await promise).toEqual({ kind: 'failed', reason: 'timeout' });
    vi.useRealTimers();
  });

  it('does NOT replay on info notices that mention /msg NickServ (regression)', async () => {
    const { session, sent, pushEvent } = makeFakeSession();
    const svc = new AthemeAccountService(session, { myNick: 'Nyan' });

    void svc.drop('Nyan', 'hunter2');
    await Promise.resolve();

    // The bare `reply with /msg NickServ HELP` phrasing used to false-
    // match the broader replay regex. Tightening the alternations is
    // what prevented the post-drop loop. Verify the regression stays
    // fixed at the impl level.
    pushEvent({ Message: 'If you need help, reply with /msg NickServ HELP for assistance.' });
    pushEvent({ Message: 'To register, type /msg NickServ REGISTER pw email.' });

    // Only the initial DROP was sent — no replay follow-ups.
    expect(sent).toEqual([{ target: 'NickServ', message: 'DROP Nyan hunter2' }]);
  });

  it('resolves {kind:"failed", reason:"could-not-parse..."} when prompt phrasing matches but no inline /msg NickServ present', async () => {
    const { session, pushEvent } = makeFakeSession();
    const svc = new AthemeAccountService(session, { myNick: 'Nyan' });

    const promise = svc.drop('Nyan', 'hunter2');

    // Pathological case — server sends the phrase but no inline cmd.
    // Make the body match REPLAY_PHRASES but lack a /msg NickServ
    // section the extractor can lock onto.
    pushEvent({ Message: 'You must reply with /msg NickServ ' });

    const result = await promise;
    expect(result.kind).toBe('failed');
    if (result.kind === 'failed') {
      expect(result.reason).toMatch(/parse|inline/i);
    }
  });
});

describe('AthemeAccountService capabilities', () => {
  it('supportsResend() returns false (Atheme has no upstream resend)', () => {
    const { session } = makeFakeSession();
    const svc = new AthemeAccountService(session, { myNick: 'Nyan' });
    expect(svc.supportsResend()).toBe(false);
  });

  it('resend() resolves to {kind:"unsupported"}', async () => {
    const { session } = makeFakeSession();
    const svc = new AthemeAccountService(session, { myNick: 'Nyan' });
    const result = await svc.resend('Nyan');
    expect(result).toEqual({ kind: 'unsupported', verb: 'resend' });
  });
});
