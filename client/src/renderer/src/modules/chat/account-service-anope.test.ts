import { describe, it, expect, vi } from 'vitest';
import { AnopeAccountService } from './account-service-anope';
import type { ServerSession } from '../engine/engine.client';
import type { IrcEvent } from '../engine/engine.types';

// FakeSession captures privmsg() calls so tests can assert what the
// service sent on the wire, and exposes a `pushEvent` helper to feed
// scripted NickServ replies back through onEvent. Mirrors the minimal
// surface the AnopeAccountService actually uses.
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

describe('AnopeAccountService.drop', () => {
  it('resolves to {kind:"dropped"} on canonical 1-arg success (vanilla Anope)', async () => {
    const { session, sent, pushEvent } = makeFakeSession();
    const svc = new AnopeAccountService(session, { myNick: 'Nyan' });

    const promise = svc.drop('Nyan', 'hunter2');

    // The impl should have fired the 1-arg DROP immediately.
    expect(sent).toEqual([{ target: 'NickServ', message: 'DROP Nyan' }]);

    pushEvent({ Message: 'Nickname \x02Nyan\x02 has been dropped.' });

    expect(await promise).toEqual({ kind: 'dropped' });
  });

  it('falls back to 2-arg DROP when server says "Syntax: DROP <account> <password>"', async () => {
    const { session, sent, pushEvent } = makeFakeSession();
    const svc = new AnopeAccountService(session, { myNick: 'Nyan' });

    const promise = svc.drop('Nyan', 'hunter2');

    expect(sent).toEqual([{ target: 'NickServ', message: 'DROP Nyan' }]);

    // Production-Anope (irc.boson.chat) replies with the syntax hint.
    pushEvent({ Message: 'Syntax: DROP <account> <password>' });

    // Impl auto-fires the 2-arg form.
    expect(sent).toEqual([
      { target: 'NickServ', message: 'DROP Nyan' },
      { target: 'NickServ', message: 'DROP Nyan hunter2' },
    ]);

    pushEvent({ Message: 'Nickname Nyan has been dropped.' });

    expect(await promise).toEqual({ kind: 'dropped' });
  });

  it('fires DROP CONFIRM follow-up on the two-step variant', async () => {
    const { session, sent, pushEvent } = makeFakeSession();
    const svc = new AnopeAccountService(session, { myNick: 'Nyan' });

    const promise = svc.drop('Nyan', 'hunter2');

    expect(sent[0]).toEqual({ target: 'NickServ', message: 'DROP Nyan' });

    pushEvent({ Message: 'To confirm, type: /msg NickServ DROP CONFIRM' });

    expect(sent[1]).toEqual({ target: 'NickServ', message: 'DROP CONFIRM' });

    pushEvent({ Message: 'Nickname Nyan has been dropped.' });

    expect(await promise).toEqual({ kind: 'dropped' });
  });

  it('resolves to {kind:"wrong-password"} on Password incorrect (2-arg fallback path)', async () => {
    const { session, pushEvent } = makeFakeSession();
    const svc = new AnopeAccountService(session, { myNick: 'Nyan' });

    const promise = svc.drop('Nyan', 'wrong-pw');

    pushEvent({ Message: 'Syntax: DROP <account> <password>' });
    pushEvent({ Message: 'Password incorrect.' });

    expect(await promise).toEqual({ kind: 'wrong-password' });
  });

  it('resolves to {kind:"no-such-account"} on Anope NICK_X_NOT_REGISTERED', async () => {
    const { session, pushEvent } = makeFakeSession();
    const svc = new AnopeAccountService(session, { myNick: 'Nyan' });

    const promise = svc.drop('Ghost', 'hunter2');

    pushEvent({ Message: "Nick \x02Ghost\x02 isn't registered." });

    expect(await promise).toEqual({ kind: 'no-such-account' });
  });

  it('times out with {kind:"failed", reason:"timeout"} when server never replies', async () => {
    vi.useFakeTimers();
    const { session, pushEvent: _pushEvent } = makeFakeSession();
    const svc = new AnopeAccountService(session, { myNick: 'Nyan', timeoutMs: 5_000 });

    const promise = svc.drop('Nyan', 'hunter2');

    await vi.advanceTimersByTimeAsync(5_000);

    expect(await promise).toEqual({ kind: 'failed', reason: 'timeout' });
    vi.useRealTimers();
  });

  it('ignores NOTICEs from non-NickServ senders', async () => {
    const { session, pushEvent } = makeFakeSession();
    const svc = new AnopeAccountService(session, { myNick: 'Nyan' });

    const promise = svc.drop('Nyan', 'hunter2');

    // Some random user PRIVMSG that contains "has been dropped"
    pushEvent({ From: 'Mallory', Kind: 'PRIVMSG', Message: 'lol your account has been dropped haha' });

    // Should still be waiting (no resolution).
    let settled = false;
    promise.then(() => { settled = true; });
    await new Promise((r) => setTimeout(r, 10));
    expect(settled).toBe(false);

    // Real NickServ resolves it.
    pushEvent({ Message: 'Nickname Nyan has been dropped.' });
    expect(await promise).toEqual({ kind: 'dropped' });
  });

  it('ignores NickServ replies addressed to someone else', async () => {
    const { session, pushEvent } = makeFakeSession();
    const svc = new AnopeAccountService(session, { myNick: 'Nyan' });

    const promise = svc.drop('Nyan', 'hunter2');

    // Notice targeted at "OtherUser" — must not resolve our promise.
    pushEvent({ Target: 'OtherUser', Message: 'Nickname OtherUser has been dropped.' });

    let settled = false;
    promise.then(() => { settled = true; });
    await new Promise((r) => setTimeout(r, 10));
    expect(settled).toBe(false);

    pushEvent({ Target: 'Nyan', Message: 'Nickname Nyan has been dropped.' });
    expect(await promise).toEqual({ kind: 'dropped' });
  });

  it('does not double-resolve if multiple terminal replies arrive', async () => {
    const { session, pushEvent } = makeFakeSession();
    const svc = new AnopeAccountService(session, { myNick: 'Nyan' });

    const promise = svc.drop('Nyan', 'hunter2');

    pushEvent({ Message: 'Nickname Nyan has been dropped.' });
    // Spurious follow-up notice that would also match — must be a no-op.
    pushEvent({ Message: 'Password incorrect.' });

    expect(await promise).toEqual({ kind: 'dropped' });
  });
});

describe('AnopeAccountService capabilities', () => {
  // identify() coverage lives in account-service-identify.test.ts.
  // register() coverage lives in account-service-register.test.ts.

  it('supportsResend() returns true for Anope', () => {
    const { session } = makeFakeSession();
    const svc = new AnopeAccountService(session, { myNick: 'Nyan' });
    expect(svc.supportsResend()).toBe(true);
  });
});

describe('AnopeAccountService.status observable', () => {
  it('replays current status synchronously on subscribe', () => {
    const { session } = makeFakeSession();
    const svc = new AnopeAccountService(session, { myNick: 'Nyan' });
    svc._setStatus('identified');

    const seen: (string | undefined)[] = [];
    svc.onStatusChange((s) => seen.push(s));

    expect(seen).toEqual(['identified']);
  });

  it('fires subscribers on each transition, ignores idempotent writes', () => {
    const { session } = makeFakeSession();
    const svc = new AnopeAccountService(session, { myNick: 'Nyan' });

    const seen: (string | undefined)[] = [];
    svc.onStatusChange((s) => seen.push(s));

    svc._setStatus('registered');
    svc._setStatus('registered');           // idempotent, no fire
    svc._setStatus('identified');
    svc._setStatus(undefined);

    // Initial undefined replay + 3 real transitions.
    expect(seen).toEqual([undefined, 'registered', 'identified', undefined]);
  });

  it('unsubscribe stops further notifications', () => {
    const { session } = makeFakeSession();
    const svc = new AnopeAccountService(session, { myNick: 'Nyan' });

    const seen: (string | undefined)[] = [];
    const unsub = svc.onStatusChange((s) => seen.push(s));

    svc._setStatus('identified');
    unsub();
    svc._setStatus('no-account');

    expect(seen).toEqual([undefined, 'identified']);
  });
});
