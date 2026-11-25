// Services and other machine traffic stay out of the conversation list:
// the app's own requests to services (the engine's detection probe and
// IDENTIFY on welcome, ChanServ / MemoServ / account flows) and their
// replies, servers' and bots' NOTICEs, CTCP — live or replayed from the
// server's history. What the user types to a service still opens its
// conversation, with every reply to it, like any IRC client.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ChatService } from './chat.service';
import type { EventListener, IrcEvent, ServerSession } from '../engine';
import {
  LocalStorageServiceCredentialsStore,
  setServiceCredentialsStore,
  getServiceCredentialsStore,
} from './services-credentials';
import { SERVICE_CHANNEL, maskServiceSecret } from './services';
import { loadServicesVerdict, saveServicesVerdict, SERVICES_VERDICT_KEY } from './services-verdict';

interface FakeSession {
  emit(e: IrcEvent): void;
  raws: string[];
  sent: Array<[string, string]>;
  framework: ((fw: string) => void) | null;
}

function makeFakeSession(): FakeSession & Record<string, unknown> {
  let listener: EventListener | null = null;
  const f: FakeSession & Record<string, unknown> = {
    serverId: 'srv-test',
    join: () => {}, part: () => {},
    privmsg: (t: string, m: string) => { f.sent.push([t, m]); },
    names: () => {}, tagmsg: () => {}, list: () => {}, away: () => {}, nick: () => {},
    nickservIdentify: () => {}, raw: (line: string) => { f.raws.push(line); },
    onEvent: (fn: EventListener) => { listener = fn; return () => { listener = null; }; },
    onChannelDirectory: () => () => {},
    onServicesFramework: (fn: (fw: string) => void) => { f.framework = fn; return () => { f.framework = null; }; },
    servicesFramework: () => null,
    emit: (e: IrcEvent) => listener?.(e),
    raws: [],
    sent: [],
    framework: null,
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
  vi.useRealTimers();
});

const ev = (e: Partial<IrcEvent> & Pick<IrcEvent, 'Kind'>): IrcEvent =>
  ({ From: '', Target: '', Message: '', Raw: '', ...e });

function build(caps = 'batch server-time chathistory', deps: Record<string, unknown> = {}) {
  const session = makeFakeSession();
  const chat = new ChatService(session as unknown as ServerSession, 'Nyan', undefined, { bouncer: true, ...deps });
  chat.attach();
  if (caps) session.emit(ev({ Kind: 'CAP', Message: caps, Args: ['ACK'] }));
  session.emit(ev({ Kind: '001', From: 'irc.test', Target: 'Nyan', Message: 'Welcome' }));
  chat.setForeground(true);
  session.emit(ev({ Kind: 'JOIN', From: 'Nyan', Target: '#lobby' }));
  chat.setActive('#lobby');
  return { chat, session };
}

const names = (chat: ChatService) => chat.getState().channels.map((c) => c.name);
const conv = (chat: ChatService, name: string) => chat.getState().channels.find((c) => c.name.toLowerCase() === name.toLowerCase());
const texts = (chat: ChatService, name: string) => conv(chat, name)?.messages.map((m) => m.text) ?? [];
const serverLog = (chat: ChatService) => texts(chat, SERVICE_CHANNEL);
const notice = (s: FakeSession, from: string, text: string) => s.emit(ev({ Kind: 'NOTICE', From: from, Target: 'Nyan', Message: text }));
const privmsg = (s: FakeSession, from: string, text: string) => s.emit(ev({ Kind: 'PRIVMSG', From: from, Target: 'Nyan', Message: text }));

function targets(s: FakeSession, list: string[]) {
  s.emit(ev({ Kind: 'BATCH', Args: ['+t1', 'chathistory-targets'] }));
  for (const t of list) s.emit(ev({ Kind: 'CHATHISTORY', Args: ['TARGETS', t, '2026-11-24T10:00:00.000Z'], Tags: { batch: 't1' } }));
  s.emit(ev({ Kind: 'BATCH', Args: ['-t1'] }));
}

function history(s: FakeSession, target: string, lines: Array<[kind: 'PRIVMSG' | 'NOTICE', from: string, to: string, text: string]>) {
  s.emit(ev({ Kind: 'BATCH', Args: ['+h1', 'chathistory', target] }));
  lines.forEach(([Kind, From, Target, Message], i) =>
    s.emit(ev({ Kind, From, Target, Message, Tags: { batch: 'h1', time: `2026-11-24T10:0${i}:00.000Z`, msgid: `${target}-${i}` } })));
  s.emit(ev({ Kind: 'BATCH', Args: ['-h1'] }));
}

describe('history: no conversations for services, servers or bots', () => {
  it("doesn't fetch the stored history of services, servers or bouncer modules", () => {
    const { session } = build();
    targets(session, ['NickServ', 'chanserv', 'Global', 'HostServ', 'magnet.rizon.net', '*status', 'alice']);
    expect(session.raws.filter((r) => r.startsWith('CHATHISTORY LATEST') && !r.includes('#'))).toEqual(['CHATHISTORY LATEST alice * 50']);
  });

  it('a sender whose stored history is only NOTICEs and CTCP gets no conversation', () => {
    const { chat, session } = build();
    targets(session, ['py-ctcp', 'Rizon']);
    history(session, 'py-ctcp', [
      ['PRIVMSG', 'py-ctcp', 'Nyan', '\x01VERSION\x01'],
      ['NOTICE', 'Nyan', 'py-ctcp', '\x01VERSION Boson 0.95\x01'],
    ]);
    history(session, 'Rizon', [['NOTICE', 'Rizon', 'Nyan', 'Welcome to Rizon! Read the rules.']]);
    expect(names(chat)).not.toContain('py-ctcp');
    expect(names(chat)).not.toContain('Rizon');
  });

  it('a real conversation still comes back, without its CTCP lines', () => {
    const { chat, session } = build();
    targets(session, ['alice']);
    history(session, 'alice', [
      ['PRIVMSG', 'alice', 'Nyan', '\x01VERSION\x01'],
      ['PRIVMSG', 'alice', 'Nyan', 'hey, you around?'],
      ['PRIVMSG', 'alice', 'Nyan', '\x01ACTION waves\x01'],
    ]);
    expect(texts(chat, 'alice')).toEqual(['hey, you around?', 'waves']);
  });
});

describe('live: NOTICEs from servers, services and bots go to the Server log', () => {
  it('server names, services and NOTICE-only bots open no conversation', () => {
    const { chat, session } = build();
    notice(session, 'irc.rizon.cc', '*** Your host is masked');
    notice(session, 'Global', '[Logon News] maintenance tonight');
    notice(session, 'Rizon', 'Please read the rules');
    notice(session, 'InfoServ', 'news');
    expect(names(chat)).toEqual(expect.not.arrayContaining(['irc.rizon.cc', 'Global', 'Rizon', 'InfoServ']));
    expect(serverLog(chat)).toEqual(expect.arrayContaining(['Please read the rules', '[Logon News] maintenance tonight']));
  });

  it('a CTCP VERSION scan opens no conversation', () => {
    const { chat, session } = build();
    privmsg(session, 'py-ctcp', '\x01VERSION\x01');
    expect(names(chat)).not.toContain('py-ctcp');
  });

  it('a PRIVMSG from a person still opens one, and a NOTICE that names you does too', () => {
    const { chat, session } = build();
    privmsg(session, 'alice', 'hi Nyan');
    notice(session, 'carol', 'Nyan, ping (notice)');
    expect(names(chat)).toEqual(expect.arrayContaining(['alice', 'carol']));
  });

  it('a NOTICE from someone you already talk to lands in that conversation', () => {
    const { chat, session } = build();
    privmsg(session, 'bot', 'hello');
    notice(session, 'bot', 'a notice');
    expect(texts(chat, 'bot')).toEqual(['hello', 'a notice']);
  });
});

describe('service conversations: what the user types, and the replies to it', () => {
  it('/msg NickServ IDENTIFY pw from a channel opens @NickServ, masked, with the reply', () => {
    const { chat, session } = build();
    chat.input('/msg NickServ IDENTIFY hunter2');
    expect(chat.getState().activeChannel?.toLowerCase()).toBe('nickserv');
    expect(session.sent).toContainEqual(['NickServ', 'IDENTIFY hunter2']);
    expect(texts(chat, 'NickServ')).toEqual(['IDENTIFY ••••••']);
    notice(session, 'NickServ', 'Password accepted - you are now recognized.');
    expect(texts(chat, 'NickServ')).toEqual(['IDENTIFY ••••••', 'Password accepted - you are now recognized.']);
    expect(serverLog(chat)).not.toContain('Password accepted - you are now recognized.');
  });

  it("the engine's probe replies on connect stay out (no @NickServ, Server log only)", () => {
    const { chat, session } = build();
    notice(session, 'NickServ', 'Unknown command VERSION. "/msg NickServ HELP" for help.');
    notice(session, 'ChanServ', 'Unknown command VERSION.');
    expect(names(chat)).not.toContain('NickServ');
    expect(names(chat)).not.toContain('ChanServ');
    expect(serverLog(chat)).toContain('Unknown command VERSION. "/msg NickServ HELP" for help.');
  });

  it('a multi-line HELP keeps flowing into the conversation; replies long after go to the Server log', () => {
    vi.useFakeTimers();
    const { chat, session } = build();
    chat.input('/msg NickServ HELP');
    for (let i = 0; i < 5; i++) {
      vi.advanceTimersByTime(10_000);
      notice(session, 'NickServ', `help line ${i}`);
    }
    expect(texts(chat, 'NickServ')).toEqual(['HELP', 'help line 0', 'help line 1', 'help line 2', 'help line 3', 'help line 4']);
    vi.advanceTimersByTime(31_000);
    notice(session, 'NickServ', 'You have been idle');
    expect(texts(chat, 'NickServ')).not.toContain('You have been idle');
    expect(serverLog(chat)).toContain('You have been idle');
  });

  it("an automatic request to the service after the user's claims its replies", () => {
    const { chat, session } = build();
    chat.input('/msg MemoServ LIST');
    notice(session, 'MemoServ', 'You have no memos.');
    expect(texts(chat, 'MemoServ')).toEqual(['LIST', 'You have no memos.']);
    chat.readMemo(1); // the Inbox reading a memo: automatic
    notice(session, 'MemoServ', 'Memo 1 from alice: hi');
    expect(texts(chat, 'MemoServ')).toEqual(['LIST', 'You have no memos.']);
  });

  it('typing in an open service conversation works the same', () => {
    const { chat, session } = build();
    chat.openDM('ChanServ');
    chat.input('INFO #x');
    expect(session.sent).toContainEqual(['ChanServ', 'INFO #x']);
    notice(session, 'ChanServ', 'Information on #x:');
    expect(texts(chat, 'ChanServ')).toEqual(['INFO #x', 'Information on #x:']);
  });

  it('/msg ChanServ INFO #x shows; registering a channel from the UI does not', async () => {
    vi.useFakeTimers();
    const { chat, session } = build();
    session.emit(ev({ Kind: '004', From: 'irc.test', Target: 'Nyan', Args: ['irc.test', 'ergo-2.19.1'] }));
    const done = chat.chanserv()!.register('#new');
    await vi.advanceTimersByTimeAsync(0);
    expect(session.sent.some(([t, m]) => t === 'ChanServ' && /^REGISTER #new/.test(m))).toBe(true);
    notice(session, 'ChanServ', 'Channel #new successfully registered');
    await vi.advanceTimersByTimeAsync(2_000);
    await done;
    // The refresh that follows a registration (INFO #new), answered too.
    notice(session, 'ChanServ', 'Information on #new:');
    await vi.advanceTimersByTimeAsync(5_000);
    await chat.chanserv()!.idle();
    expect(names(chat)).not.toContain('ChanServ');

    chat.input('/msg ChanServ INFO #x');
    notice(session, 'ChanServ', 'Channel #x is not registered');
    expect(texts(chat, 'ChanServ')).toEqual(['INFO #x', 'Channel #x is not registered']);
  });

  it('after a reconnect: the probe stays out, what the user types lands in the conversation they had', () => {
    const first = build();
    first.chat.input('/msg NickServ HELP');
    first.session.emit(ev({ Kind: 'ACK', Message: '999' })); // delivered
    notice(first.session, 'NickServ', 'help text');
    const carried = first.chat.exportConversations();

    const session = makeFakeSession();
    const chat = new ChatService(session as unknown as ServerSession, 'Nyan', undefined, { bouncer: true });
    chat.seedConversations(carried);
    chat.attach();
    session.emit(ev({ Kind: '001', From: 'irc.test', Target: 'Nyan', Message: 'Welcome' }));
    notice(session, 'NickServ', 'Unknown command VERSION.');
    expect(texts(chat, 'NickServ')).toEqual(['HELP', 'help text']);
    chat.setActive('NickServ');
    chat.input('STATUS');
    notice(session, 'NickServ', 'STATUS Nyan 3');
    expect(texts(chat, 'NickServ')).toEqual(['HELP', 'help text', 'STATUS', 'STATUS Nyan 3']);
  });

  it('a masked line is resent with its real text, never the mask', () => {
    const { chat, session } = build();
    chat.input('/msg NickServ IDENTIFY hunter2');
    session.sent.length = 0;
    // Reconnect on the same service (welcome again): the pending line goes again.
    session.emit(ev({ Kind: '001', From: 'irc.test', Target: 'Nyan', Message: 'Welcome' }));
    for (const [, m] of session.sent) expect(m).not.toContain('••••••');
  });
});

describe('maskServiceSecret', () => {
  it.each([
    ['NickServ', 'IDENTIFY hunter2', 'IDENTIFY ••••••'],
    ['nickserv', 'identify Nyan hunter2', 'identify Nyan ••••••'],
    ['NickServ', 'REGISTER hunter2 me@example.com', 'REGISTER •••••• me@example.com'],
    ['NickServ', 'GHOST Nyan hunter2', 'GHOST Nyan ••••••'],
    ['NickServ', 'RECOVER Nyan', 'RECOVER Nyan'],
    ['NickServ', 'SET PASSWORD newpass', 'SET PASSWORD ••••••'],
    ['NickServ', 'PASSWD old new', 'PASSWD •••••• ••••••'],
    ['NickServ', 'HELP', 'HELP'],
    ['ChanServ', 'IDENTIFY #chan secret', 'IDENTIFY #chan ••••••'],
    ['ChanServ', 'SET #chan PASSWORD secret', 'SET #chan PASSWORD ••••••'],
    ['ChanServ', 'INFO #chan', 'INFO #chan'],
    ['alice', 'IDENTIFY hunter2', 'IDENTIFY hunter2'],
  ])('%s %s', (target, text, want) => {
    expect(maskServiceSecret(target, text)).toBe(want);
  });
});

describe('services verdict: remembered per server, so the next connect needn\'t probe', () => {
  it('saves a definite verdict, forgets "unknown", ignores junk', () => {
    const s = memStorage();
    saveServicesVerdict('srv1', 'anope', s);
    saveServicesVerdict('srv2', 'atheme', s);
    expect(loadServicesVerdict('srv1', s)).toBe('anope');
    saveServicesVerdict('srv1', 'unknown', s);
    expect(loadServicesVerdict('srv1', s)).toBeUndefined();
    expect(loadServicesVerdict('srv2', s)).toBe('atheme');
    s.setItem(SERVICES_VERDICT_KEY, '{"srv3":"bogus","srv4":"ergo"}');
    expect(loadServicesVerdict('srv3', s)).toBeUndefined();
    expect(loadServicesVerdict('srv4', s)).toBe('ergo');
    s.setItem(SERVICES_VERDICT_KEY, 'not json');
    expect(loadServicesVerdict('srv4', s)).toBeUndefined();
  });

  it("ChatService saves the engine's verdict for its server", () => {
    const saved: Array<[string, string]> = [];
    const { session } = build('', { servicesVerdicts: { save: (id: string, fw: string) => saved.push([id, fw]) } });
    session.framework?.('anope');
    expect(saved).toEqual([['srv-test', 'anope']]);
  });
});
