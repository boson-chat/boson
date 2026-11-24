import { describe, it, expect } from 'vitest';
import { ChatService } from './chat.service';
import type { EventListener, IrcEvent, ServerSession } from '../engine';

// echo-message: our own lines come back from the server with a msgid. The
// line shown when it was sent takes it (no second line), so it can be
// replied to; an echo nothing waits for (another device) shows once.

function fakeSession() {
  let listener: EventListener | null = null;
  const f = {
    serverId: 'srv',
    sent: [] as Array<{ target: string; message: string }>,
    privmsg: (target: string, message: string) => { f.sent.push({ target, message }); },
    probe: () => {},
    join: () => {}, part: () => {}, names: () => {}, tagmsg: () => {}, list: () => {}, raw: () => {},
    away: () => {}, nick: () => {}, nickservIdentify: () => {},
    onEvent: (fn: EventListener) => { listener = fn; return () => { listener = null; }; },
    onChannelDirectory: () => () => {},
    onServicesFramework: () => () => {},
    servicesFramework: () => null,
    emit: (e: Partial<IrcEvent>) => listener?.({ Kind: '', From: '', Target: '', Message: '', Raw: '', ...e }),
  };
  return f;
}

type Fake = ReturnType<typeof fakeSession>;

function chatOn(s: Fake, caps = 'message-tags echo-message server-time'): ChatService {
  const chat = new ChatService(s as unknown as ServerSession, 'me');
  chat.attach();
  if (caps) s.emit({ Kind: 'CAP', Args: ['ACK'], Message: caps });
  s.emit({ Kind: '001', From: 'srv', Target: 'me' });
  s.emit({ Kind: 'JOIN', From: 'me', Target: '#general' });
  chat.setActive('#general');
  return chat;
}

let n = 0;
// The server's copy of a line we sent.
function echo(s: Fake, target: string, message: string, over: Partial<IrcEvent> = {}): string {
  const msgid = `id${++n}`;
  s.emit({ Kind: 'PRIVMSG', From: 'me', Target: target, Message: message, Tags: { msgid, time: '2026-11-24T10:00:00.000Z' }, ...over });
  return msgid;
}

const conv = (chat: ChatService, name: string) =>
  chat.getState().channels.find((c) => c.name.toLowerCase() === name.toLowerCase())?.messages
    .filter((m) => m.kind !== 'join' && m.kind !== 'system') ?? [];
const log = (chat: ChatService) => chat.getState().serverLog.map((l) => l.message);

describe('ChatService — echo-message', () => {
  it('the echo gives the shown line its msgid and server time; no second line', () => {
    const s = fakeSession();
    const chat = chatOn(s);
    chat.send('#general', 'hello');
    expect(conv(chat, '#general')[0]!.pending).toBe(true);
    const id = echo(s, '#general', 'hello');
    const ms = conv(chat, '#general');
    expect(ms).toHaveLength(1);
    expect(ms[0]).toMatchObject({ text: 'hello', from: 'me', msgid: id, serverTime: Date.parse('2026-11-24T10:00:00.000Z') });
    // It reached the server: not pending, not resent after a reconnect.
    expect(ms[0]!.pending).toBeUndefined();
  });

  it('lines sent while an echo is in flight pair up in order, even with the same text', () => {
    const s = fakeSession();
    const chat = chatOn(s);
    chat.send('#general', 'ok');
    chat.send('#general', 'ok');
    chat.send('#general', 'sure');
    const a = echo(s, '#general', 'ok');
    const b = echo(s, '#general', 'ok');
    const c = echo(s, '#general', 'sure');
    expect(conv(chat, '#general').map((m) => [m.text, m.msgid])).toEqual([['ok', a], ['ok', b], ['sure', c]]);
  });

  it('a multi-line paste (one PRIVMSG per line) pairs line by line; a blank line may come back trimmed', () => {
    const s = fakeSession();
    const chat = chatOn(s);
    for (const l of ['# Title', ' ', '  indented']) chat.send('#general', l);
    const ids = [echo(s, '#general', '# Title'), echo(s, '#general', ''), echo(s, '#general', '  indented')];
    expect(conv(chat, '#general').map((m) => m.msgid)).toEqual(ids);
  });

  it('a long line the engine split comes back in parts: the first takes the msgid, the rest add nothing', () => {
    const s = fakeSession();
    const chat = chatOn(s);
    const long = Array.from({ length: 80 }, (_, i) => `word${i}`).join(' ');
    chat.send('#general', long);
    const cut = long.indexOf(' word40');
    const id = echo(s, '#general', long.slice(0, cut));
    echo(s, '#general', long.slice(cut + 1));
    const ms = conv(chat, '#general');
    expect(ms).toHaveLength(1);
    expect(ms[0]!.msgid).toBe(id);
    // Then a new line is matched normally.
    chat.send('#general', 'after');
    const after = echo(s, '#general', 'after');
    expect(conv(chat, '#general').map((m) => m.msgid)).toEqual([id, after]);
  });

  it('/me: the ACTION echo (\\x01ACTION …\\x01) pairs with the shown action', () => {
    const s = fakeSession();
    const chat = chatOn(s);
    chat.input('/me waves');
    const id = echo(s, '#general', '\x01ACTION waves\x01');
    const ms = conv(chat, '#general');
    expect(ms).toHaveLength(1);
    expect(ms[0]).toMatchObject({ kind: 'action', text: 'waves', msgid: id });
  });

  it('CTCP other than ACTION, and CTCP replies, show nothing', () => {
    const s = fakeSession();
    const chat = chatOn(s);
    echo(s, 'bob', '\x01VERSION\x01');
    echo(s, 'bob', '\x01VERSION boson 1.0\x01', { Kind: 'NOTICE' });
    echo(s, '#general', '\x01PING 123\x01');
    expect(conv(chat, '#general')).toHaveLength(0);
    expect(chat.getState().channels.some((c) => c.name === 'bob')).toBe(false);
  });

  it('a NOTICE echo with no line waiting shows once as our notice', () => {
    const s = fakeSession();
    const chat = chatOn(s);
    const id = echo(s, '#general', 'heads up', { Kind: 'NOTICE' });
    echo(s, '#general', 'heads up', { Kind: 'NOTICE', Tags: { msgid: id } });
    const ms = conv(chat, '#general');
    expect(ms).toHaveLength(1);
    expect(ms[0]).toMatchObject({ kind: 'notice', from: 'me', msgid: id });
  });

  it('lines to services: /msg NickServ keeps its one line; engine-sent commands add none and stay out of the log', () => {
    const s = fakeSession();
    const chat = chatOn(s);
    chat.input('/msg NickServ INFO');
    echo(s, 'NickServ', 'INFO');
    expect(conv(chat, 'NickServ').map((m) => m.text)).toEqual(['INFO']);
    expect(conv(chat, 'NickServ')[0]!.msgid).toBeTruthy();
    // IDENTIFY sent by the engine / account services: no pane, no log line.
    echo(s, 'NickServ', 'IDENTIFY me hunter2');
    echo(s, 'ChanServ', 'INFO #general');
    echo(s, '*status', 'ListNetworks');
    expect(conv(chat, 'NickServ').map((m) => m.text)).toEqual(['INFO']);
    expect(chat.getState().channels.some((c) => c.name === 'ChanServ' || c.name === '*status')).toBe(false);
    expect(log(chat).some((l) => l.includes('hunter2'))).toBe(false);
  });

  it('a line from another device (no line waiting) shows once, as ours — in a channel and in a DM', () => {
    const s = fakeSession();
    const chat = chatOn(s);
    const id = echo(s, '#general', 'from my phone');
    // A bouncer may relay it again: the msgid keeps it to one line.
    echo(s, '#general', 'from my phone', { Tags: { msgid: id } });
    expect(conv(chat, '#general').map((m) => [m.from, m.text, m.msgid])).toEqual([['me', 'from my phone', id]]);
    echo(s, 'bob', 'hi bob, from the phone');
    expect(conv(chat, 'bob').map((m) => [m.from, m.text])).toEqual([['me', 'hi bob, from the phone']]);
  });

  it('a DM to a nick in other case pairs with the shown line', () => {
    const s = fakeSession();
    const chat = chatOn(s);
    chat.input('/msg Bob hey');
    echo(s, 'bob', 'hey');
    expect(conv(chat, 'Bob')).toHaveLength(1);
    expect(conv(chat, 'Bob')[0]!.msgid).toBeTruthy();
  });

  it('resend after a reconnect: the resent line waits again and its echo pairs with it', () => {
    const s = fakeSession();
    const chat = chatOn(s);
    chat.send('#general', 'lost?');
    // The connection drops before the echo; a new one, then the rejoin
    // resends what's pending.
    s.emit({ Kind: '001', From: 'srv', Target: 'me' });
    s.emit({ Kind: 'JOIN', From: 'me', Target: '#general' });
    expect(s.sent.filter((x) => x.message === 'lost?')).toHaveLength(2);
    const id = echo(s, '#general', 'lost?');
    const ms = conv(chat, '#general');
    expect(ms).toHaveLength(1);
    expect(ms[0]).toMatchObject({ msgid: id });
    expect(ms[0]!.pending).toBeUndefined();
  });

  it('a reply to our own line finds it by the msgid the echo gave it', () => {
    const s = fakeSession();
    const chat = chatOn(s);
    chat.send('#general', 'which port?');
    const id = echo(s, '#general', 'which port?');
    s.emit({ Kind: 'PRIVMSG', From: 'bob', Target: '#general', Message: '6697', Tags: { msgid: 'b1', '+draft/reply': id } });
    const [mine, reply] = conv(chat, '#general');
    expect(reply!.replyTo).toBe(mine!.msgid);
  });

  it('without echo-message: as before — our lines from elsewhere are shown in channels, nothing is paired', () => {
    const s = fakeSession();
    const chat = chatOn(s, 'message-tags');
    chat.send('#general', 'hello');
    // A bouncer relaying a line we sent from another device.
    s.emit({ Kind: 'PRIVMSG', From: 'me', Target: '#general', Message: 'from elsewhere', Tags: { msgid: 'x1' } });
    const ms = conv(chat, '#general');
    expect(ms.map((m) => m.text)).toEqual(['hello', 'from elsewhere']);
    expect(ms[0]!.msgid).toBeUndefined();
    expect(ms[0]!.pending).toBe(true);
    // DMs to others from elsewhere were never shown without echo-message.
    s.emit({ Kind: 'PRIVMSG', From: 'me', Target: 'bob', Message: 'psst' });
    expect(chat.getState().channels.some((c) => c.name === 'bob')).toBe(false);
  });
});
