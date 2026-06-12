import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ChatService, type NickClaimAPI } from './chat.service';
import type { EventListener, IrcEvent, ServerSession } from '../engine';
import { MemoryChatHistoryStore } from '../history';
import {
  LocalStorageServiceCredentialsStore,
  setServiceCredentialsStore,
  getServiceCredentialsStore,
} from './services-credentials';
import type { NickClaimPollResponse } from '../directory/directory.types';

// Tests for ChatService.claimNick — the end-to-end automated
// "claim this nick" flow for signed-in users. The flow has many
// branches (happy path, nick-taken, expired mid-poll, cancel via
// AbortSignal, backend unreachable). We mock the NickClaimAPI + the
// IRC session so the test never touches a real socket or backend.

interface FakeSession extends Pick<ServerSession,
  'join' | 'part' | 'privmsg' | 'names' | 'tagmsg' | 'list' | 'away' | 'nick' |
  'nickservIdentify' | 'raw' | 'onEvent' | 'onChannelDirectory' |
  'onServicesFramework' | 'servicesFramework' | 'serverId'
> {
  emit(e: IrcEvent): void;
  sentPrivmsgs: { target: string; message: string }[];
}

function makeFakeSession(): FakeSession {
  let listener: EventListener | null = null;
  const sent: { target: string; message: string }[] = [];
  const f: FakeSession = {
    serverId: 'srv-test',
    join: () => {},
    part: () => {},
    privmsg: (target, message) => { sent.push({ target, message }); },
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
    sentPrivmsgs: sent,
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

let savedStore: ReturnType<typeof getServiceCredentialsStore>;

beforeEach(() => {
  savedStore = getServiceCredentialsStore();
  setServiceCredentialsStore(new LocalStorageServiceCredentialsStore(memStorage()));
});

afterEach(() => {
  setServiceCredentialsStore(savedStore);
});

function buildChat(api: NickClaimAPI): { chat: ChatService; session: FakeSession } {
  const session = makeFakeSession();
  const chat = new ChatService(
    session as unknown as ServerSession,
    'Nyan',
    { history: new MemoryChatHistoryStore(), scope: { userId: 'u1', serverId: 'srv-test' } },
    { nickClaimAPI: api },
  );
  chat.attach();
  return { chat, session };
}

// Plays the IRC server's REGISTER + CONFIRM replies back through
// the chat service's event stream. Used to drive AccountService's
// register/confirm runners to resolution.
function fireRegisterPendingReply(session: FakeSession): void {
  session.emit({
    Kind: 'NOTICE',
    From: 'NickServ',
    Target: 'Nyan',
    Message: 'Please type "/msg NickServ CONFIRM abcd1234" to confirm your account.',
    Raw: '',
  });
}

function fireConfirmedReply(session: FakeSession): void {
  session.emit({
    Kind: 'NOTICE',
    From: 'NickServ',
    Target: 'Nyan',
    Message: 'Your account is now confirmed.',
    Raw: '',
  });
}

function fireNickTakenReply(session: FakeSession): void {
  session.emit({
    Kind: 'NOTICE',
    From: 'NickServ',
    Target: 'Nyan',
    Message: 'Nickname Nyan is already registered.',
    Raw: '',
  });
}

describe('ChatService.claimNick — happy path', () => {
  it('full flow: mint → register → poll → confirm → claimed', async () => {
    const createCalls: { serverId: string; accountNick: string }[] = [];
    const getCalls: string[] = [];
    let pollCount = 0;

    const api: NickClaimAPI = {
      createNickClaim: async (input) => {
        createCalls.push(input);
        return { id: 'claim-1', email: 'reg-uid-abcd1234@boson.chat' };
      },
      getNickClaim: async (id) => {
        getCalls.push(id);
        pollCount++;
        // First poll → still pending. Second poll → captured.
        if (pollCount === 1) {
          return { status: 'pending' } as NickClaimPollResponse;
        }
        return { status: 'captured', code: 'abcd1234' };
      },
    };
    const { chat, session } = buildChat(api);

    const promise = chat.claimNick('Nyan');

    // Yield so the createNickClaim call settles and registerAccount
    // fires its initial PRIVMSG.
    await new Promise((r) => setTimeout(r, 0));
    fireRegisterPendingReply(session);
    // Yield again so the poll loop runs.
    await new Promise((r) => setTimeout(r, 0));
    // Drive a few iterations so the second poll returns captured.
    await new Promise((r) => setTimeout(r, 2100));
    // After the captured poll, confirmAccount fires its PRIVMSG.
    fireConfirmedReply(session);

    const result = await promise;
    expect(result).toEqual({ kind: 'claimed' });

    // Wire format: a REGISTER then a CONFIRM with the captured code.
    const messages = session.sentPrivmsgs.map((s) => s.message);
    expect(messages.some((m) => m.startsWith('REGISTER '))).toBe(true);
    expect(messages.some((m) => m.includes(' reg-uid-abcd1234@boson.chat'))).toBe(true);
    expect(messages).toContain('CONFIRM abcd1234');

    // Backend was called for both mint + at least 2 polls.
    expect(createCalls).toEqual([{ serverId: 'srv-test', accountNick: 'Nyan' }]);
    expect(getCalls.length).toBeGreaterThanOrEqual(2);

    // Generated password persisted; pendingRegistration cleared.
    const creds = getServiceCredentialsStore().get('srv-test');
    expect(creds?.nickservPassword).toBeTruthy();
    expect(creds?.generatedPassword).toBe(true);
    expect(creds?.pendingRegistration).toBeUndefined();
    expect(creds?.status).toBe('identified');
  }, 10_000);
});

describe('ChatService.claimNick — failure modes', () => {
  it('returns nick-taken when REGISTER reply says already-registered', async () => {
    const api: NickClaimAPI = {
      createNickClaim: async () => ({ id: 'c-2', email: 'reg-uid-x@boson.chat' }),
      getNickClaim: async () => ({ status: 'pending' }),
    };
    const { chat, session } = buildChat(api);

    const promise = chat.claimNick('Nyan');
    await new Promise((r) => setTimeout(r, 0));
    fireNickTakenReply(session);

    const result = await promise;
    expect(result.kind).toBe('nick-taken');
    // Password NOT persisted on failure.
    expect(getServiceCredentialsStore().get('srv-test')?.nickservPassword).toBeUndefined();
  });

  it('returns expired when the poll sees status=expired', async () => {
    const api: NickClaimAPI = {
      createNickClaim: async () => ({ id: 'c-3', email: 'reg-uid-y@boson.chat' }),
      getNickClaim: async () => ({ status: 'expired' }),
    };
    const { chat, session } = buildChat(api);

    const promise = chat.claimNick('Nyan');
    await new Promise((r) => setTimeout(r, 0));
    fireRegisterPendingReply(session);
    // The first poll returns expired immediately.

    const result = await promise;
    expect(result.kind).toBe('expired');
  });

  it('returns unavailable when createNickClaim rejects', async () => {
    const api: NickClaimAPI = {
      createNickClaim: async () => { throw new Error('network down'); },
      getNickClaim: async () => { throw new Error('not reached'); },
    };
    const { chat } = buildChat(api);

    const result = await chat.claimNick('Nyan');
    expect(result.kind).toBe('unavailable');
    if (result.kind === 'unavailable') expect(result.reason).toContain('network');
  });

  it('returns unavailable when no NickClaimAPI is wired', async () => {
    const session = makeFakeSession();
    const chat = new ChatService(
      session as unknown as ServerSession,
      'Nyan',
      { history: new MemoryChatHistoryStore(), scope: { userId: 'u1', serverId: 'srv-test' } },
      // No nickClaimAPI dep
    );
    chat.attach();

    const result = await chat.claimNick('Nyan');
    expect(result.kind).toBe('unavailable');
  });

  it('cancels cleanly when the AbortSignal fires mid-poll', async () => {
    const api: NickClaimAPI = {
      createNickClaim: async () => ({ id: 'c-4', email: 'reg-uid-z@boson.chat' }),
      getNickClaim: async () => ({ status: 'pending' }),
    };
    const { chat, session } = buildChat(api);

    const ctrl = new AbortController();
    const promise = chat.claimNick('Nyan', { signal: ctrl.signal });
    await new Promise((r) => setTimeout(r, 0));
    fireRegisterPendingReply(session);
    // Let the poll loop start, then abort.
    await new Promise((r) => setTimeout(r, 10));
    ctrl.abort();

    const result = await promise;
    expect(result.kind).toBe('cancelled');
  });
});

describe('ChatService.claimNick — persistence', () => {
  it('writes pendingRegistration to the credentials store before REGISTER fires', async () => {
    const api: NickClaimAPI = {
      createNickClaim: async () => ({ id: 'c-5', email: 'reg-uid-w@boson.chat' }),
      // Make poll hang so we can observe mid-flight state.
      getNickClaim: vi.fn().mockImplementation(() => new Promise(() => {})),
    };
    const { chat, session } = buildChat(api);

    const ctrl = new AbortController();
    const promise = chat.claimNick('Nyan', { signal: ctrl.signal });
    await new Promise((r) => setTimeout(r, 0));

    // After create-claim resolves but before register reply, the
    // pendingRegistration record should be persisted so a reload
    // can resume.
    const creds = getServiceCredentialsStore().get('srv-test');
    expect(creds?.pendingRegistration).toEqual({
      id: 'c-5',
      email: 'reg-uid-w@boson.chat',
    });
    expect(creds?.status).toBe('registering');

    // Tidy up so the test process doesn't hang on the never-resolving
    // poll promise.
    fireRegisterPendingReply(session);
    ctrl.abort();
    await promise;
  });
});
