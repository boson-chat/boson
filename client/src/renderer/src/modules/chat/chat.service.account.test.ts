import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ChatService } from './chat.service';
import type { EventListener, IrcEvent, ServerSession } from '../engine';
import { MemoryChatHistoryStore } from '../history';
import {
  LocalStorageServiceCredentialsStore,
  setServiceCredentialsStore,
  getServiceCredentialsStore,
  type ServiceCredentials,
} from './services-credentials';

// Verifies that NickServ NOTICEs feed through `classifyNickServReply`
// and update the credentials store's `status` field. The Services
// panel subscribes to the same store, so its badge reflects the
// most recent classification without any explicit refresh.
//
// Companion to chat.service.memos.test.ts (which pins down the
// parallel MemoServ → Inbox routing). The two tests intentionally
// live in separate files so the routing surfaces stay independent.

interface FakeSession extends Pick<ServerSession,
  'join' | 'part' | 'privmsg' | 'names' | 'tagmsg' | 'list' | 'away' | 'nick' |
  'nickservIdentify' | 'raw' | 'onEvent' | 'onChannelDirectory' |
  'onServicesFramework' | 'servicesFramework' | 'serverId'
> {
  emit(e: IrcEvent): void;
}

function makeFakeSession(): FakeSession {
  let listener: EventListener | null = null;
  const f: FakeSession = {
    serverId: 'srv-test',
    join: () => {},
    part: () => {},
    privmsg: () => {},
    names: () => {},
    tagmsg: () => {},
    list: () => {},
    away: () => {},
    nick: () => {},
    nickservIdentify: () => {},
    raw: () => {},
    onEvent: (fn) => { listener = fn; return () => { listener = null; }; },
    onChannelDirectory: () => () => {},
    onServicesFramework: () => () => {},
    servicesFramework: () => null,
    emit: (e) => listener?.(e),
  };
  return f;
}

function memStorage(): Storage {
  const m = new Map<string, string>();
  return {
    getItem: (k) => m.get(k) ?? null,
    setItem: (k, v) => { m.set(k, v); },
    removeItem: (k) => { m.delete(k); },
    clear: () => { m.clear(); },
    key: (i) => Array.from(m.keys())[i] ?? null,
    get length() { return m.size; },
  };
}

let saved: ReturnType<typeof getServiceCredentialsStore>;
let store: LocalStorageServiceCredentialsStore;

beforeEach(() => {
  saved = getServiceCredentialsStore();
  store = new LocalStorageServiceCredentialsStore(memStorage());
  setServiceCredentialsStore(store);
});

afterEach(() => {
  setServiceCredentialsStore(saved);
});

function ev(partial: Partial<IrcEvent>): IrcEvent {
  return { Kind: '', From: '', Target: '', Message: '', Raw: '', ...partial };
}

function chatFor(opts: { persistence?: boolean } = {}): { chat: ChatService; session: FakeSession } {
  const session = makeFakeSession();
  const persist = opts.persistence !== false;
  const chat = new ChatService(
    session as unknown as ServerSession,
    'me',
    persist
      ? { history: new MemoryChatHistoryStore(), scope: { userId: 'u1', serverId: 'srv-test' } }
      : undefined,
  );
  chat.attach();
  return { chat, session };
}

describe('ChatService — NickServ reply → account status', () => {
  it('successful identify lands status=identified', () => {
    const { session } = chatFor();
    session.emit(ev({
      Kind: 'NOTICE',
      From: 'NickServ',
      Target: 'me',
      Message: 'You are now identified for alice.',
    }));
    expect(store.get('srv-test')?.status).toBe('identified');
  });

  it('failed identify lands status=identify-failed', () => {
    const { session } = chatFor();
    session.emit(ev({
      Kind: 'NOTICE',
      From: 'NickServ',
      Target: 'me',
      Message: 'Password incorrect.',
    }));
    expect(store.get('srv-test')?.status).toBe('identify-failed');
  });

  it('CONFIRM prompt lands status=pending-confirmation', () => {
    const { session } = chatFor();
    session.emit(ev({
      Kind: 'NOTICE',
      From: 'NickServ',
      Target: 'me',
      Message: 'Please type "/msg NickServ CONFIRM ab12cd34" to confirm your account.',
    }));
    expect(store.get('srv-test')?.status).toBe('pending-confirmation');
  });

  it('email-verification complete lands status=registered', () => {
    const { session } = chatFor();
    session.emit(ev({
      Kind: 'NOTICE',
      From: 'NickServ',
      Target: 'me',
      Message: 'Email verification complete.',
    }));
    expect(store.get('srv-test')?.status).toBe('registered');
  });

  it('identified-success while pending-confirmation → identified-unconfirmed (preserves pending state)', () => {
    // Anope flow: REGISTER lands "Please type CONFIRM" → status pending-confirmation.
    // User reconnects, auto-IDENTIFY succeeds (Anope lets you identify unconfirmed accounts).
    // The "Password accepted" reply must NOT overwrite pending-confirmation with plain
    // identified — the account is still unconfirmed server-side and the confirm prompt
    // needs to keep showing. Live-observed regression on irc.boson.chat.
    store.set('srv-test', { status: 'pending-confirmation', nickservPassword: 'pw' });
    const { session } = chatFor();
    session.emit(ev({
      Kind: 'NOTICE',
      From: 'NickServ',
      Target: 'me',
      Message: 'Password accepted - you are now recognized as Nyan.',
    }));
    expect(store.get('srv-test')?.status).toBe('identified-unconfirmed');
  });

  it('identified-success while identified-unconfirmed stays identified-unconfirmed', () => {
    // Re-identify on a still-unconfirmed account (e.g. nick change + IDENTIFY)
    // must not silently "promote" the status to fully identified.
    store.set('srv-test', { status: 'identified-unconfirmed', nickservPassword: 'pw' });
    const { session } = chatFor();
    session.emit(ev({
      Kind: 'NOTICE',
      From: 'NickServ',
      Target: 'me',
      Message: 'Password accepted - you are now recognized as Nyan.',
    }));
    expect(store.get('srv-test')?.status).toBe('identified-unconfirmed');
  });

  it('identified-success from unknown/registered → identified (normal path)', () => {
    // Sanity: when there's no pending state, identified-success still lands
    // the plain identified status.
    store.set('srv-test', { status: 'registered', nickservPassword: 'pw' });
    const { session } = chatFor();
    session.emit(ev({
      Kind: 'NOTICE',
      From: 'NickServ',
      Target: 'me',
      Message: 'Password accepted - you are now recognized as Nyan.',
    }));
    expect(store.get('srv-test')?.status).toBe('identified');
  });

  it('identified-success auto-fires INFO <acct> to verify confirmation state (transition probe)', () => {
    // After a cold reload + fresh identify, the prior status was
    // `unknown`, so the priority override that catches pending-
    // confirmation doesn't fire. Without a verification probe, the
    // user lands at `identified` and never sees the "confirm your
    // email" prompt until they manually run Check status.
    //
    // This test pins that the badge transition INTO `identified`
    // automatically fires INFO so the classifier picks up any
    // unconfirmed marker in the reply.
    const privmsgCalls: Array<{ target: string; body: string }> = [];
    const session = makeFakeSession();
    session.privmsg = (target: string, body: string) => privmsgCalls.push({ target, body });

    const chat = new ChatService(
      session as unknown as ServerSession,
      'Nyan',
      { history: new MemoryChatHistoryStore(), scope: { userId: 'u1', serverId: 'srv-test' } },
    );
    chat.attach();
    store.set('srv-test', { accountName: 'Nyan' });

    session.emit(ev({
      Kind: 'NOTICE',
      From: 'NickServ',
      Target: 'Nyan',
      Message: 'Password accepted - you are now recognized as Nyan.',
    }));

    expect(privmsgCalls).toEqual([{ target: 'NickServ', body: 'INFO Nyan' }]);
    expect(store.get('srv-test')?.status).toBe('identified');
  });

  it('identified-success does NOT auto-fire INFO when already identified (no transition)', () => {
    // Defensive: receiving "you are already identified" while the
    // badge is already `identified` shouldn't keep firing INFO every
    // time the user runs IDENTIFY again. Only the transition edge
    // (prev !== identified) fires the probe.
    const privmsgCalls: Array<{ target: string; body: string }> = [];
    const session = makeFakeSession();
    session.privmsg = (target: string, body: string) => privmsgCalls.push({ target, body });

    const chat = new ChatService(
      session as unknown as ServerSession,
      'Nyan',
      { history: new MemoryChatHistoryStore(), scope: { userId: 'u1', serverId: 'srv-test' } },
    );
    chat.attach();
    store.set('srv-test', { accountName: 'Nyan', status: 'identified' });

    session.emit(ev({
      Kind: 'NOTICE',
      From: 'NickServ',
      Target: 'Nyan',
      Message: 'You are already identified.',
    }));

    expect(privmsgCalls).toEqual([]);
  });

  it('registration-confirmed while identified → identified (no demotion)', () => {
    // Realistic flow: user registers, identifies, then later confirms.
    // The confirm reply must NOT demote them back to `registered` —
    // they're already logged in.
    store.set('srv-test', { status: 'identified', nickservPassword: 'pw' });
    const { session } = chatFor();
    session.emit(ev({
      Kind: 'NOTICE',
      From: 'NickServ',
      Target: 'me',
      Message: 'Email verification complete.',
    }));
    expect(store.get('srv-test')?.status).toBe('identified');
  });

  it('registration-confirmed while identified-unconfirmed → identified', () => {
    // The textbook upgrade path: identified-unconfirmed + confirm-success
    // means the user is now fully identified.
    store.set('srv-test', { status: 'identified-unconfirmed', nickservPassword: 'pw' });
    const { session } = chatFor();
    session.emit(ev({
      Kind: 'NOTICE',
      From: 'NickServ',
      Target: 'me',
      Message: 'Email verification complete.',
    }));
    expect(store.get('srv-test')?.status).toBe('identified');
  });

  it('"this nickname is registered" prompt does NOT overwrite a prior identified state', () => {
    // Rationale: the nudge tells us the NICK is registered, not that
    // we failed to identify. If we'd previously identified, that
    // status should stick.
    store.set('srv-test', { status: 'identified', nickservPassword: 'pw' });
    const { session } = chatFor();
    session.emit(ev({
      Kind: 'NOTICE',
      From: 'NickServ',
      Target: 'me',
      Message: 'This nickname is registered. Please choose a different nickname or identify.',
    }));
    expect(store.get('srv-test')?.status).toBe('identified');
  });

  it('preserves saved password and email when only status changes', () => {
    store.set('srv-test', {
      nickservPassword: 'hunter2',
      email: 'alice@example.com',
      accountName: 'alice',
      generatedPassword: false,
      status: 'registered',
    });
    const { session } = chatFor();
    session.emit(ev({
      Kind: 'NOTICE',
      From: 'NickServ',
      Target: 'me',
      Message: 'You are now identified for alice.',
    }));
    const got = store.get('srv-test');
    expect(got).toEqual({
      nickservPassword: 'hunter2',
      email: 'alice@example.com',
      accountName: 'alice',
      generatedPassword: false,
      status: 'identified',
    });
  });

  it('ignores unrelated NOTICE bodies — leaves the saved status alone', () => {
    store.set('srv-test', { status: 'identified' });
    const { session } = chatFor();
    session.emit(ev({
      Kind: 'NOTICE',
      From: 'NickServ',
      Target: 'me',
      Message: 'Welcome to the network!',
    }));
    expect(store.get('srv-test')?.status).toBe('identified');
  });

  it('case-insensitive sender match — NICKSERV vs NickServ vs nickserv', () => {
    const { session } = chatFor();
    for (const sender of ['NICKSERV', 'NickServ', 'nickserv']) {
      store.clear('srv-test');
      session.emit(ev({
        Kind: 'NOTICE',
        From: sender,
        Target: 'me',
        Message: 'You are now identified.',
      }));
      expect(store.get('srv-test')?.status).toBe('identified');
    }
  });

  it('does NOT update status when persistence (and therefore serverId) is missing', () => {
    // Without a stable serverId there's nothing to key into the store
    // with — silent no-op rather than writing to an empty key.
    const { session } = chatFor({ persistence: false });
    session.emit(ev({
      Kind: 'NOTICE',
      From: 'NickServ',
      Target: 'me',
      Message: 'You are now identified.',
    }));
    // No entries created.
    expect(store.get('srv-test')).toBeNull();
    expect(store.get('')).toBeNull();
  });

  it('subscribers see the status transition synchronously', () => {
    const { session } = chatFor();
    const seen: Array<ServiceCredentials | null> = [];
    store.subscribe('srv-test', (v) => { seen.push(v); });
    session.emit(ev({
      Kind: 'NOTICE',
      From: 'NickServ',
      Target: 'me',
      Message: 'You are now identified for alice.',
    }));
    // Initial null from subscribe + the post-update fire.
    expect(seen.length).toBe(2);
    expect(seen[1]?.status).toBe('identified');
  });

  it('registration-confirmed auto-fires IDENTIFY when a password is saved', () => {
    // Server flow: user clicks Register → REGISTER fires → server
    // skips email confirmation and replies "has been registered" →
    // classifier maps to 'registered' → ChatService auto-fires
    // IDENTIFY using the saved password so the user lands as
    // identified without a second click.
    const identifyCalls: string[] = [];
    const session = makeFakeSession();
    session.nickservIdentify = (pw: string) => identifyCalls.push(pw);

    const chat = new ChatService(
      session as unknown as ServerSession,
      'me',
      { history: new MemoryChatHistoryStore(), scope: { userId: 'u1', serverId: 'srv-test' } },
    );
    chat.attach();
    store.set('srv-test', {
      nickservPassword: 'hunter2',
      accountName: 'alice',
      status: 'registering',
    });

    session.emit(ev({
      Kind: 'NOTICE',
      From: 'NickServ',
      Target: 'me',
      Message: 'Your account is now confirmed.',
    }));

    expect(identifyCalls).toEqual(['hunter2']);
    // Status reflects the classifier's write; a follow-up
    // "you are now identified" reply would then flip it to 'identified'.
    expect(store.get('srv-test')?.status).toBe('registered');
  });

  it('registration-confirmed does NOT auto-fire IDENTIFY when no password is saved', () => {
    // Defensive: if creds got cleared between REGISTER and the reply,
    // we shouldn't bounce off NickServ with an empty IDENTIFY.
    const identifyCalls: string[] = [];
    const session = makeFakeSession();
    session.nickservIdentify = (pw: string) => identifyCalls.push(pw);

    const chat = new ChatService(
      session as unknown as ServerSession,
      'me',
      { history: new MemoryChatHistoryStore(), scope: { userId: 'u1', serverId: 'srv-test' } },
    );
    chat.attach();

    session.emit(ev({
      Kind: 'NOTICE',
      From: 'NickServ',
      Target: 'me',
      Message: 'Your account is now confirmed.',
    }));

    expect(identifyCalls).toEqual([]);
  });

  it('numeric 900 (RPL_LOGGEDIN) flips status to identified directly — no NickServ round-trip needed', () => {
    // RPL_LOGGEDIN fires on SASL success, on NickServ CONFIRM
    // completion, and on some daemons every reconnect once
    // identified. Strong signal — flip the badge immediately.
    store.set('srv-test', { status: 'identified-unconfirmed', nickservPassword: 'pw' });
    const { session } = chatFor();
    session.emit(ev({
      Kind: '900',
      From: 'irc.boson.chat',
      Target: 'Nyan',
      Args: ['Nyan', 'Nyan!Nyan@host', 'Nyan'],
      Message: 'You are now logged in as Nyan.',
    }));
    expect(store.get('srv-test')?.status).toBe('identified');
  });

  it('numeric 900 is a no-op when there is no persisted serverId scope', () => {
    const { session } = chatFor({ persistence: false });
    session.emit(ev({
      Kind: '900',
      From: 'irc.boson.chat',
      Target: 'Nyan',
      Args: ['Nyan', 'Nyan!Nyan@host', 'Nyan'],
      Message: 'You are now logged in as Nyan.',
    }));
    // No persistence → no scope.serverId → silent no-op.
    expect(store.get('srv-test')).toBeNull();
  });

  it('post-CONFIRM "email address has been confirmed" while identified-unconfirmed → identified', () => {
    // Realistic flow: user IDENTIFIED first (status = identified-unconfirmed
    // because the account was registered but not yet confirmed), then later
    // CONFIRMED via the code. The confirm reply must promote to plain
    // `identified` — they're already logged in; demoting to `registered`
    // would lose the logged-in state.
    store.set('srv-test', {
      nickservPassword: 'hunter2',
      accountName: 'Nyan',
      status: 'identified-unconfirmed',
    });
    const { session } = chatFor();
    session.emit(ev({
      Kind: 'NOTICE',
      From: 'NickServ',
      Target: 'me',
      Message: 'Your email address of hi+nyan@boson.chat has been confirmed.',
    }));
    expect(store.get('srv-test')?.status).toBe('identified');
  });

  it('"is an unconfirmed nickname" lands status=identified-unconfirmed (Anope INFO marker)', () => {
    const { session } = chatFor();
    session.emit(ev({
      Kind: 'NOTICE',
      From: 'NickServ',
      Target: 'me',
      Message: 'Nyan is an unconfirmed nickname.',
    }));
    expect(store.get('srv-test')?.status).toBe('identified-unconfirmed');
  });

  it('"email address is not confirmed" lands status=identified-unconfirmed', () => {
    const { session } = chatFor();
    session.emit(ev({
      Kind: 'NOTICE',
      From: 'NickServ',
      Target: 'me',
      Message: 'Your email address is not confirmed. To confirm it, follow the instructions emailed to you.',
    }));
    expect(store.get('srv-test')?.status).toBe('identified-unconfirmed');
  });

  it('"will expire, if not confirmed" lands status=identified-unconfirmed', () => {
    const { session } = chatFor();
    session.emit(ev({
      Kind: 'NOTICE',
      From: 'NickServ',
      Target: 'me',
      Message: 'Your account will expire, if not confirmed, in 23 hours, 55 minutes.',
    }));
    expect(store.get('srv-test')?.status).toBe('identified-unconfirmed');
  });

  it('"You are already identified" lands status=identified', () => {
    // Observed live on irc.boson.chat — surfaces after a re-IDENTIFY
    // when services already know us. Same end-state as a fresh
    // identify-success, so the badge should reflect that.
    const { session } = chatFor();
    session.emit(ev({
      Kind: 'NOTICE',
      From: 'NickServ',
      Target: 'me',
      Message: 'You are already identified.',
    }));
    expect(store.get('srv-test')?.status).toBe('identified');
  });

  it('drop-success clears the saved password + email and lands status=no-account', () => {
    // After the user (or a fresh DROP via the Identity UI) succeeds,
    // the account is gone — so the local creds shouldn't keep
    // pointing at a now-defunct password. We retain `accountName` so
    // the empty-state UI can still mention which nick was dropped.
    store.set('srv-test', {
      nickservPassword: 'hunter2',
      email: 'alice@example.com',
      accountName: 'alice',
      status: 'identified',
    });
    const { session } = chatFor();
    session.emit(ev({
      Kind: 'NOTICE',
      From: 'NickServ',
      Target: 'me',
      Message: 'Nickname Nyan has been dropped.',
    }));
    const got = store.get('srv-test');
    expect(got).toEqual({
      accountName: 'alice',
      status: 'no-account',
    });
  });

  it('does NOT auto-fire the 2-arg DROP from maybeUpdateAccountStatus (Step 2 — handled by AnopeAccountService)', () => {
    // BEHAVIOUR CHANGE in Step 2 of the AccountService migration.
    // Previously, classifying a "Syntax: DROP <account> <password>"
    // reply triggered an inline DROP <acct> <pw> re-fire from
    // ChatService.maybeUpdateAccountStatus. After Step 2, that
    // multi-step dance is owned by AnopeAccountService.drop()
    // internally — firing here too would cause a double-send. So
    // the side-effect was deliberately removed, and this test pins
    // the new contract.
    //
    // Unit coverage for the 2-arg fallback lives in
    // account-service-anope.test.ts ("falls back to 2-arg DROP
    // when server says 'Syntax: DROP …'").
    const privmsgCalls: Array<{ target: string; body: string }> = [];
    const session = makeFakeSession();
    session.privmsg = (target: string, body: string) => privmsgCalls.push({ target, body });

    const chat = new ChatService(
      session as unknown as ServerSession,
      'me',
      { history: new MemoryChatHistoryStore(), scope: { userId: 'u1', serverId: 'srv-test' } },
    );
    chat.attach();
    store.set('srv-test', {
      nickservPassword: 'hunter2',
      accountName: 'alice',
      status: 'identified',
    });

    session.emit(ev({
      Kind: 'NOTICE',
      From: 'NickServ',
      Target: 'me',
      Message: 'Syntax: DROP <account> <password>',
    }));

    expect(privmsgCalls).toEqual([]);
  });

  it('does NOT auto-retry the 2-arg DROP when no password is saved', () => {
    // Defensive: if the user cleared their creds between the first
    // DROP and the "Syntax:" reply, we shouldn't fire a malformed
    // command (DROP nick "") at NickServ.
    const privmsgCalls: Array<{ target: string; body: string }> = [];
    const session = makeFakeSession();
    session.privmsg = (target: string, body: string) => privmsgCalls.push({ target, body });

    const chat = new ChatService(
      session as unknown as ServerSession,
      'me',
      { history: new MemoryChatHistoryStore(), scope: { userId: 'u1', serverId: 'srv-test' } },
    );
    chat.attach();
    store.set('srv-test', { accountName: 'alice' });

    session.emit(ev({
      Kind: 'NOTICE',
      From: 'NickServ',
      Target: 'me',
      Message: 'Syntax: DROP <account> <password>',
    }));

    expect(privmsgCalls).toEqual([]);
  });

  it('writes a resendCooldownUntil ~5min ahead when NickServ rejects RESEND', () => {
    store.set('srv-test', { status: 'pending-confirmation', accountName: 'alice' });
    const { session } = chatFor();
    const before = Date.now();
    session.emit(ev({
      Kind: 'NOTICE',
      From: 'NickServ',
      Target: 'me',
      Message: 'Cannot send mail now; please retry a little later.',
    }));
    const after = Date.now();
    const persisted = store.get('srv-test');
    expect(persisted?.resendCooldownUntil).toBeDefined();
    // Pinned to Date.now() + 5min — assert the window is in the
    // expected range so a slightly slow CI doesn't flake.
    const lower = before + 5 * 60_000 - 1000;
    const upper = after + 5 * 60_000 + 1000;
    expect(persisted!.resendCooldownUntil!).toBeGreaterThanOrEqual(lower);
    expect(persisted!.resendCooldownUntil!).toBeLessThanOrEqual(upper);
    // Account status itself stays at pending-confirmation.
    expect(persisted?.status).toBe('pending-confirmation');
  });

  it("does NOT bump status on a resend-success reply (it's only a side-effect signal)", () => {
    store.set('srv-test', { status: 'pending-confirmation', accountName: 'alice' });
    const { session } = chatFor();
    session.emit(ev({
      Kind: 'NOTICE',
      From: 'NickServ',
      Target: 'me',
      Message: 'The confirmation code for alice has been re-sent to alice@example.com.',
    }));
    expect(store.get('srv-test')?.status).toBe('pending-confirmation');
    // No cooldown either — success doesn't trigger one.
    expect(store.get('srv-test')?.resendCooldownUntil).toBeUndefined();
  });

  it('does NOT replay inline /msg commands from maybeUpdateAccountStatus (Step 3 — handled by AccountService impls)', () => {
    // BEHAVIOUR CHANGE in Step 3 of the AccountService migration.
    // Both Anope (Step 2) and Atheme (Step 3) drop flows are now
    // self-contained in their AccountService impls — they each own
    // their own replay logic against the same prompt phrasings.
    // Firing the replay here too would cause double-sends, so this
    // side-effect was removed.
    //
    // Coverage for the actual replay lives in:
    //   - account-service-anope.test.ts (Anope 3-arg DROP variant)
    //   - account-service-atheme.test.ts (Atheme two-step KEY)
    const privmsgCalls: Array<{ target: string; body: string }> = [];
    const session = makeFakeSession();
    session.privmsg = (target: string, body: string) => privmsgCalls.push({ target, body });

    const chat = new ChatService(
      session as unknown as ServerSession,
      'me',
      { history: new MemoryChatHistoryStore(), scope: { userId: 'u1', serverId: 'srv-test' } },
    );
    chat.attach();

    // Anope-style 3-arg DROP prompt.
    session.emit(ev({
      Kind: 'NOTICE',
      From: 'NickServ',
      Target: 'me',
      Message: 'Please confirm by replying with /msg NickServ DROP alice ~user@host.example abc123:def456',
    }));

    // Atheme-style bold-wrapped key prompt.
    session.emit(ev({
      Kind: 'NOTICE',
      From: 'NickServ',
      Target: 'me',
      Message: 'Please confirm by replying with \x02/msg NickServ DROP alice hunter2 abc123\x02',
    }));

    // Anope canonical DROP CONFIRM prompt.
    session.emit(ev({
      Kind: 'NOTICE',
      From: 'NickServ',
      Target: 'me',
      Message: 'To confirm, type: /msg NickServ DROP CONFIRM',
    }));

    // None of the three replies should produce an outbound privmsg
    // from maybeUpdateAccountStatus — the AccountService impls own
    // those follow-ups now, and they're only listening when an
    // operation is in flight.
    expect(privmsgCalls).toEqual([]);
  });

  it('drop-success on a row without any saved password still flips status + keeps accountName', () => {
    store.set('srv-test', { accountName: 'alice' });
    const { session } = chatFor();
    session.emit(ev({
      Kind: 'NOTICE',
      From: 'NickServ',
      Target: 'me',
      Message: 'The account alice has been dropped.',
    }));
    expect(store.get('srv-test')).toEqual({
      accountName: 'alice',
      status: 'no-account',
    });
  });

  it('a recognized NickServ reply updates status and stays in ~server (transactional, NOT the Inbox)', () => {
    const { chat, session } = chatFor();
    session.emit(ev({
      Kind: 'NOTICE',
      From: 'NickServ',
      Target: 'me',
      Message: 'You are now identified for alice.',
    }));
    // Status classifier ran…
    expect(store.get('srv-test')?.status).toBe('identified');
    // …and because it's a *recognized* (transactional) reply, it's treated as
    // connect/auth noise: kept in the ~server log, NOT routed to the Inbox.
    const serverCh = chat.getState().channels.find((c) => c.name === '~server');
    const fromNickServ = serverCh?.messages.filter((m) => m.from.toLowerCase() === 'nickserv') ?? [];
    expect(fromNickServ.length).toBe(1);
  });
});
