import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ChatService, type NickClaimAPI } from './chat.service';
import type { EventListener, IrcEvent, ServerSession } from '../engine';
import { MemoryChatHistoryStore } from '../history';
import {
  LocalStorageServiceCredentialsStore,
  setServiceCredentialsStore,
  getServiceCredentialsStore,
} from './services-credentials';
import type { NickClaimPollResponse } from '../directory/directory.types';

// Tests for ChatService.detectAccountState (the on-open NickServ
// state probe that drives the right CTA) and resumePendingConfirmation
// (auto-finishing a stranded confirmation from a captured backend
// code). Both mock the IRC session + NickClaimAPI.

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
    join: () => {}, part: () => {},
    privmsg: (target, message) => { sent.push({ target, message }); },
    names: () => {}, tagmsg: () => {}, list: () => {}, away: () => {}, nick: () => {},
    nickservIdentify: () => {}, raw: () => {},
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
afterEach(() => { setServiceCredentialsStore(savedStore); });

function buildChat(api?: NickClaimAPI): { chat: ChatService; session: FakeSession } {
  const session = makeFakeSession();
  const chat = new ChatService(
    session as unknown as ServerSession,
    'Nyan',
    { history: new MemoryChatHistoryStore(), scope: { userId: 'u1', serverId: 'srv-test' } },
    api ? { nickClaimAPI: api } : undefined,
  );
  chat.attach();
  return { chat, session };
}

const tick = () => new Promise((r) => setTimeout(r, 0));
function emitNotice(session: FakeSession, message: string): void {
  session.emit({ Kind: 'NOTICE', From: 'NickServ', Target: 'Nyan', Message: message, Raw: '' });
}

describe('ChatService.detectAccountState', () => {
  it('unregistered nick → no-account (Claim CTA territory)', async () => {
    const { chat, session } = buildChat();
    const p = chat.detectAccountState('Nyan');
    await tick();
    // INFO probe fired on the wire.
    expect(session.sentPrivmsgs.some((s) => s.message === 'INFO Nyan')).toBe(true);
    emitNotice(session, "Nick Nyan isn't registered."); // early-resolves runInfo
    expect(await p).toBe('no-account');
    expect(getServiceCredentialsStore().get('srv-test')?.status).toBe('no-account');
  });

  it('registered-but-unconfirmed → pending-confirmation', async () => {
    const { chat, session } = buildChat();
    const p = chat.detectAccountState('Nyan');
    await tick();
    emitNotice(session, 'Account: Nyan');
    emitNotice(session, 'Nyan is an unconfirmed nickname.');
    emitNotice(session, 'Email address: reg-x@boson.chat');
    // Wait out the INFO settle window so runInfo resolves.
    await new Promise((r) => setTimeout(r, 800));
    expect(await p).toBe('pending-confirmation');
    const creds = getServiceCredentialsStore().get('srv-test');
    expect(creds?.status).toBe('pending-confirmation');
    expect(creds?.email).toBe('reg-x@boson.chat');
  }, 10_000);

  it('registered + confirmed → registered (Identify territory, Claim hidden)', async () => {
    const { chat, session } = buildChat();
    const p = chat.detectAccountState('Nyan');
    await tick();
    emitNotice(session, 'Account: Nyan');
    emitNotice(session, 'Registered: Jun 01 12:00:00 2026 UTC');
    emitNotice(session, 'Options: Security');
    await new Promise((r) => setTimeout(r, 800));
    expect(await p).toBe('registered');
    expect(getServiceCredentialsStore().get('srv-test')?.status).toBe('registered');
  }, 10_000);
});

describe('ChatService.resumePendingConfirmation', () => {
  function seedPending(): void {
    getServiceCredentialsStore().set('srv-test', {
      accountName: 'Nyan',
      nickservPassword: 'gen-pw',
      generatedPassword: true,
      status: 'pending-confirmation',
      pendingRegistration: { id: 'claim-1', email: 'reg-x@boson.chat' },
    });
  }

  it('captured code → CONFIRM → confirmed, clears pending, status identified', async () => {
    seedPending();
    const api: NickClaimAPI = {
      createNickClaim: async () => ({ id: 'unused', email: 'x' }),
      getNickClaim: async () => ({ status: 'captured', code: 'q2XXVoHAt' } as NickClaimPollResponse),
    };
    const { chat, session } = buildChat(api);

    const p = chat.resumePendingConfirmation();
    await tick(); // getNickClaim resolves captured → confirmAccount fires CONFIRM
    emitNotice(session, 'Your account is now confirmed.');

    expect(await p).toEqual({ kind: 'confirmed' });
    expect(session.sentPrivmsgs.some((s) => s.message === 'CONFIRM q2XXVoHAt')).toBe(true);
    const creds = getServiceCredentialsStore().get('srv-test');
    expect(creds?.pendingRegistration).toBeUndefined();
    expect(creds?.status).toBe('identified');
  });

  it('captured code but server rejects it → wrong-code', async () => {
    seedPending();
    const api: NickClaimAPI = {
      createNickClaim: async () => ({ id: 'unused', email: 'x' }),
      getNickClaim: async () => ({ status: 'captured', code: 'bad' } as NickClaimPollResponse),
    };
    const { chat, session } = buildChat(api);

    const p = chat.resumePendingConfirmation();
    await tick();
    emitNotice(session, 'Invalid passcode.');

    expect(await p).toEqual({ kind: 'wrong-code' });
    // Pending claim is left intact so the user can retry / paste.
    expect(getServiceCredentialsStore().get('srv-test')?.pendingRegistration).toBeTruthy();
  });

  it('no pending claim → unavailable', async () => {
    // Store has creds but no pendingRegistration.
    getServiceCredentialsStore().set('srv-test', { accountName: 'Nyan', status: 'registered' });
    const api: NickClaimAPI = {
      createNickClaim: async () => ({ id: 'x', email: 'x' }),
      getNickClaim: async () => ({ status: 'pending' }),
    };
    const { chat } = buildChat(api);
    const r = await chat.resumePendingConfirmation();
    expect(r.kind).toBe('unavailable');
  });

  it('aborted signal → still-pending (no confirm fired)', async () => {
    seedPending();
    const api: NickClaimAPI = {
      createNickClaim: async () => ({ id: 'x', email: 'x' }),
      getNickClaim: async () => ({ status: 'pending' }),
    };
    const { chat, session } = buildChat(api);
    const ctrl = new AbortController();
    ctrl.abort();
    const r = await chat.resumePendingConfirmation(undefined, { signal: ctrl.signal });
    expect(r.kind).toBe('still-pending');
    expect(session.sentPrivmsgs.some((s) => s.message.startsWith('CONFIRM'))).toBe(false);
  });
});
