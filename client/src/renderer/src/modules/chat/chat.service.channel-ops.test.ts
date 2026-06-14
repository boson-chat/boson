import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ChatService } from './chat.service';
import type { EventListener, IrcEvent, ServerSession } from '../engine';
import { MemoryChatHistoryStore } from '../history';
import {
  LocalStorageServiceCredentialsStore,
  setServiceCredentialsStore,
  getServiceCredentialsStore,
} from './services-credentials';

// Channel-operator action methods + slash-command verbs. Asserts the exact raw
// IRC line each emits (the server is authoritative on permission; we just send).

interface FakeSession extends Pick<ServerSession,
  'join'|'part'|'privmsg'|'names'|'tagmsg'|'list'|'away'|'nick'|
  'nickservIdentify'|'raw'|'onEvent'|'onChannelDirectory'|'onServicesFramework'|'servicesFramework'|'serverId'> {
  emit(e: IrcEvent): void;
  raws: string[];
}
function makeFakeSession(): FakeSession {
  let listener: EventListener | null = null;
  const raws: string[] = [];
  const f: FakeSession = {
    serverId: 'srv', join: () => {}, part: () => {}, privmsg: () => {},
    names: () => {}, tagmsg: () => {}, list: () => {}, away: () => {}, nick: () => {},
    nickservIdentify: () => {}, raw: (line) => { raws.push(line); },
    onEvent: (fn) => { listener = fn; return () => { listener = null; }; },
    onChannelDirectory: () => () => {}, onServicesFramework: () => () => {},
    servicesFramework: () => null, emit: (e) => listener?.(e), raws,
  };
  return f;
}
function memStorage(): Storage {
  const m = new Map<string, string>();
  return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => { m.set(k, v); },
    removeItem: (k) => { m.delete(k); }, clear: () => { m.clear(); },
    key: (i) => Array.from(m.keys())[i] ?? null, get length() { return m.size; } } as Storage;
}
let saved: ReturnType<typeof getServiceCredentialsStore>;
beforeEach(() => { saved = getServiceCredentialsStore(); setServiceCredentialsStore(new LocalStorageServiceCredentialsStore(memStorage())); });
afterEach(() => { setServiceCredentialsStore(saved); });

function build(): { chat: ChatService; session: FakeSession } {
  const session = makeFakeSession();
  const chat = new ChatService(session as unknown as ServerSession, 'Nyan',
    { history: new MemoryChatHistoryStore(), scope: { userId: 'u', serverId: 'srv' } });
  chat.attach();
  session.emit({ Kind: 'JOIN', From: 'Nyan', Target: '#t', Message: '', Raw: '' }); // becomes active
  return { chat, session };
}
const last = (s: FakeSession) => s.raws[s.raws.length - 1];

describe('ChatService — channel-op action methods', () => {
  it('emits the right raw line for each action', () => {
    const { chat, session } = build();
    chat.kick('#t', 'bob');                 expect(last(session)).toBe('KICK #t bob');
    chat.kick('#t', 'bob', 'rude');         expect(last(session)).toBe('KICK #t bob :rude');
    chat.ban('#t', 'bob!*@*');              expect(last(session)).toBe('MODE #t +b bob!*@*');
    chat.unban('#t', 'bob!*@*');            expect(last(session)).toBe('MODE #t -b bob!*@*');
    chat.setMemberMode('#t', 'bob', '+o');  expect(last(session)).toBe('MODE #t +o bob');
    chat.setMemberMode('#t', 'bob', '-v');  expect(last(session)).toBe('MODE #t -v bob');
    chat.invite('bob', '#t');               expect(last(session)).toBe('INVITE bob #t');
    chat.setTopic('#t', 'hello world');     expect(last(session)).toBe('TOPIC #t :hello world');
    chat.setChannelMode('#t', '+m');        expect(last(session)).toBe('MODE #t +m');
    chat.setChannelMode('#t', '+l 50');     expect(last(session)).toBe('MODE #t +l 50');
    chat.requestChannelModes('#t');         expect(last(session)).toBe('MODE #t');
  });

  it('kickBan bans (best mask) then kicks, in order', () => {
    const { chat, session } = build();
    session.raws.length = 0;
    chat.kickBan('#t', 'bob', '1.2.3.4', 'spam');
    expect(session.raws).toEqual(['MODE #t +b *!*@1.2.3.4', 'KICK #t bob :spam']);
  });

  it('requestBanList flags loading and sends MODE #t +b', () => {
    const { chat, session } = build();
    chat.requestBanList('#t');
    expect(chat.getState().channels.find((c) => c.name === '#t')!.banListLoading).toBe(true);
    expect(last(session)).toBe('MODE #t +b');
  });
});

describe('ChatService — channel-op slash commands', () => {
  const run = () => { const b = build(); b.session.raws.length = 0; return b; };

  it('/kick with and without reason', () => {
    const { chat, session } = run();
    chat.input('/kick bob'); expect(last(session)).toBe('KICK #t bob');
    chat.input('/kick bob being rude'); expect(last(session)).toBe('KICK #t bob :being rude');
  });

  it('/ban builds nick!*@* for a bare nick, passes a mask through', () => {
    const { chat, session } = run();
    chat.input('/ban bob');       expect(last(session)).toBe('MODE #t +b bob!*@*');
    chat.input('/ban *!*@evil');  expect(last(session)).toBe('MODE #t +b *!*@evil');
  });

  it('/op /deop /halfop /voice /devoice', () => {
    const { chat, session } = run();
    chat.input('/op bob');      expect(last(session)).toBe('MODE #t +o bob');
    chat.input('/deop bob');    expect(last(session)).toBe('MODE #t -o bob');
    chat.input('/halfop bob');  expect(last(session)).toBe('MODE #t +h bob');
    chat.input('/voice bob');   expect(last(session)).toBe('MODE #t +v bob');
    chat.input('/devoice bob'); expect(last(session)).toBe('MODE #t -v bob');
  });

  it('/invite and /topic', () => {
    const { chat, session } = run();
    chat.input('/invite bob');           expect(last(session)).toBe('INVITE bob #t');
    chat.input('/invite bob #other');    expect(last(session)).toBe('INVITE bob #other');
    chat.input('/topic new shiny topic'); expect(last(session)).toBe('TOPIC #t :new shiny topic');
    chat.input('/topic');                 expect(last(session)).toBe('TOPIC #t'); // view
  });

  it('emits a usage hint instead of a raw line when args are missing', () => {
    const { chat, session } = run();
    chat.input('/kick');
    expect(session.raws).toHaveLength(0); // no raw command sent
  });
});
