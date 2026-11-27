import { describe, it, expect, vi } from 'vitest';
import { ChatService, REPLY_TAG, replyOf } from './chat.service';
import type { EventListener, IrcEvent, ServerSession } from '../engine';

// IRCv3 replies: a reply goes out as PRIVMSG with `+draft/reply=<msgid>`
// (only where the server negotiated message-tags), and an incoming one —
// live or from chathistory — keeps the msgid it answers.

function fakeSession() {
  let listener: EventListener | null = null;
  const f = {
    serverId: 'srv',
    sent: [] as Array<{ target: string; message: string; ack?: number; tags?: Record<string, string> }>,
    privmsg: (target: string, message: string, ack?: number, tags?: Record<string, string>) => {
      f.sent.push({ target, message, ack, ...(tags ? { tags } : {}) });
    },
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

function chatOn(session: ReturnType<typeof fakeSession>, caps?: string): ChatService {
  const chat = new ChatService(session as unknown as ServerSession, 'me');
  chat.attach();
  if (caps) session.emit({ Kind: 'CAP', Args: ['ACK'], Message: caps });
  session.emit({ Kind: 'JOIN', From: 'me', Target: '#general' });
  chat.setActive('#general');
  return chat;
}

const msgs = (chat: ChatService, name: string) =>
  chat.getState().channels.find((c) => c.name === name)?.messages.filter((m) => m.kind === 'message') ?? [];

describe('replyOf', () => {
  it('reads +draft/reply, and the ratified +reply', () => {
    expect(replyOf({ '+draft/reply': 'abc' })).toEqual({ replyTo: 'abc' });
    expect(replyOf({ '+reply': 'xyz' })).toEqual({ replyTo: 'xyz' });
    expect(replyOf({ msgid: 'm1' })).toEqual({});
    expect(replyOf(undefined)).toEqual({});
    expect(replyOf({ '+draft/reply': '' })).toEqual({});
  });
});

describe('ChatService — replies', () => {
  it('with message-tags, a reply is sent with +draft/reply and kept on the local echo', () => {
    const s = fakeSession();
    const chat = chatOn(s, 'message-tags server-time');
    expect(chat.repliesSupported()).toBe(true);
    chat.send('#general', 'yes, that', { replyTo: 'msg-1' });
    expect(s.sent).toEqual([{ target: '#general', message: 'yes, that', ack: 1, tags: { [REPLY_TAG]: 'msg-1' } }]);
    expect(msgs(chat, '#general')[0]!.replyTo).toBe('msg-1');
  });

  it('input() passes the reply through to the active channel', () => {
    const s = fakeSession();
    const chat = chatOn(s, 'message-tags');
    chat.input('agreed', { replyTo: 'msg-2' });
    expect(s.sent[0]!.tags).toEqual({ [REPLY_TAG]: 'msg-2' });
  });

  it('without message-tags the line goes out plain (no tag, no replyTo)', () => {
    const s = fakeSession();
    const chat = chatOn(s);
    expect(chat.repliesSupported()).toBe(false);
    chat.send('#general', 'plain', { replyTo: 'msg-1' });
    expect(s.sent[0]!.tags).toBeUndefined();
    expect(msgs(chat, '#general')[0]!.replyTo).toBeUndefined();
  });

  it('a pending reply is resent with its tag after a reconnect', () => {
    const s = fakeSession();
    const chat = chatOn(s, 'message-tags');
    chat.send('#general', 'still here?', { replyTo: 'msg-9' });
    // Rejoined before any ACK: what's pending goes out again, tag and all.
    s.emit({ Kind: 'JOIN', From: 'me', Target: '#general' });
    const resent = s.sent.filter((x) => x.message === 'still here?');
    expect(resent.length).toBeGreaterThanOrEqual(1);
    for (const r of resent) expect(r.tags).toEqual({ [REPLY_TAG]: 'msg-9' });
  });

  it('an incoming reply keeps the msgid it answers', () => {
    const s = fakeSession();
    const chat = chatOn(s, 'message-tags');
    s.emit({ Kind: 'PRIVMSG', From: 'alice', Target: '#general', Message: 'first', Tags: { msgid: 'a1' } });
    s.emit({ Kind: 'PRIVMSG', From: 'bob', Target: '#general', Message: 're: first', Tags: { msgid: 'b1', '+draft/reply': 'a1' } });
    const [first, reply] = msgs(chat, '#general');
    expect(first!.replyTo).toBeUndefined();
    expect(reply!.replyTo).toBe('a1');
    expect(reply!.msgid).toBe('b1');
  });
});

// The text form (replies.ts): every reply starts with who it answers, for
// clients that don't read the tag; one without a tag is read back by it.
describe('ChatService — replies, text form', () => {
  const said = (s: ReturnType<typeof fakeSession>, from: string, text: string, tags: Record<string, string> = {}) =>
    s.emit({ Kind: 'PRIVMSG', From: from, Target: '#general', Message: text, Tags: tags });
  const idOf = (chat: ChatService, text: string) => msgs(chat, '#general').find((m) => m.text === text)!.id;

  function bobSaid(s: ReturnType<typeof fakeSession>): void {
    said(s, 'bob', 'anyone know why the build fails on arm?', { msgid: 'b1' });
    said(s, 'bob', 'also is the meeting at 3 or 4?', { msgid: 'b2' });
    said(s, 'bob', 'anyone around?', { msgid: 'b3' });
  }

  it('with message-tags: the tag and the text prefix', () => {
    const s = fakeSession();
    const chat = chatOn(s, 'message-tags');
    bobSaid(s);
    chat.send('#general', "it's libssl-dev", { replyTo: 'b1', replyToId: idOf(chat, 'anyone know why the build fails on arm?') });
    chat.send('#general', '4pm', { replyTo: 'b2' });
    chat.send('#general', 'yep', { replyTo: 'b3' });
    expect(s.sent.map((x) => [x.message, x.tags?.[REPLY_TAG]])).toEqual([
      ['bob: "anyone know..." it\'s libssl-dev', 'b1'],
      ['bob: "also..." 4pm', 'b2'],
      ['bob: "anyone around..." yep', 'b3'],
    ]);
    const echo = msgs(chat, '#general').at(-1)!;
    expect(echo).toMatchObject({ text: 'bob: "anyone around..." yep', replyTo: 'b3', replyToId: idOf(chat, 'anyone around?') });
  });

  it('without message-tags (ngircd): the text form alone, linked by local id', () => {
    const s = fakeSession();
    const chat = chatOn(s);
    said(s, 'bob', 'is the relay up?');
    said(s, 'bob', 'hello?');
    const target = idOf(chat, 'is the relay up?');
    chat.send('#general', 'yes', { replyToId: target });
    expect(s.sent[0]).toMatchObject({ message: 'bob: "is..." yes' });
    expect(s.sent[0]!.tags).toBeUndefined();
    expect(msgs(chat, '#general').at(-1)).toMatchObject({ replyToId: target });
    expect(msgs(chat, '#general').at(-1)!.replyTo).toBeUndefined();
  });

  it('does not add the nick when the line already addresses them', () => {
    const s = fakeSession();
    const chat = chatOn(s);
    said(s, 'bob', 'hi');
    chat.send('#general', 'bob: hello', { replyToId: idOf(chat, 'hi') });
    expect(s.sent[0]!.message).toBe('bob: hello');
  });

  it('a resend after a reconnect keeps the prefix once', () => {
    const s = fakeSession();
    const chat = chatOn(s, 'message-tags');
    said(s, 'bob', 'hi', { msgid: 'h1' });
    chat.send('#general', 'still here?', { replyTo: 'h1' });
    s.emit({ Kind: 'JOIN', From: 'me', Target: '#general' });
    for (const r of s.sent) expect(r.message).toBe('bob: "hi..." still here?');
  });

  it('reads a quoted text reply back as a reply; a bare `nick:` is just a mention', () => {
    const s = fakeSession();
    const chat = chatOn(s);
    bobSaid(s);
    said(s, 'carol', 'bob: "anyone know..." libssl-dev');
    said(s, 'carol', 'bob: yes');
    const [first] = msgs(chat, '#general').slice(0, 1);
    const quoted = msgs(chat, '#general').find((m) => m.text.startsWith('bob: "'))!;
    const plain = msgs(chat, '#general').find((m) => m.text === 'bob: yes')!;
    expect(quoted).toMatchObject({ replyToId: first!.id });
    expect(quoted.replyGuess).toBeUndefined();
    expect(plain.replyToId).toBeUndefined();
    expect(plain.replyGuess).toBeUndefined();
  });

  it('links text replies in a chathistory batch too', () => {
    const s = fakeSession();
    const chat = chatOn(s, 'batch chathistory server-time');
    s.emit({ Kind: 'BATCH', Args: ['+h1', 'chathistory', '#general'] });
    s.emit({ Kind: 'PRIVMSG', From: 'bob', Target: '#general', Message: 'ship it?', Tags: { batch: 'h1', time: '2026-11-01T10:00:00Z', msgid: 'x1' } });
    s.emit({ Kind: 'PRIVMSG', From: 'carol', Target: '#general', Message: 'bob: "ship..." yes', Tags: { batch: 'h1', time: '2026-11-01T10:01:00Z', msgid: 'x2' } });
    s.emit({ Kind: 'PRIVMSG', From: 'dave', Target: '#general', Message: 'bob: nice', Tags: { batch: 'h1', time: '2026-11-01T10:02:00Z', msgid: 'x3' } });
    s.emit({ Kind: 'BATCH', Args: ['-h1'] });
    const list = msgs(chat, '#general');
    expect(list.find((m) => m.msgid === 'x2')).toMatchObject({ replyToId: list.find((m) => m.msgid === 'x1')!.id });
    expect(list.find((m) => m.msgid === 'x3')!.replyToId).toBeUndefined();
  });
});

// A reply to one of your own lines is a mention, whether or not it says
// your nick: notifications, the unread highlight, the Inbox.
describe('ChatService — replies count as mentions', () => {
  function setup(caps?: string) {
    const s = fakeSession();
    const chat = chatOn(s, caps);
    const notes: Array<{ kind: string; text: string }> = [];
    chat.setNotifier((ev) => notes.push({ kind: ev.kind, text: ev.text }));
    s.emit({ Kind: 'JOIN', From: 'me', Target: '#other' });
    chat.setActive('#other');
    return { s, chat, notes };
  }
  const chan = (chat: ChatService) => chat.getState().channels.find((c) => c.name === '#general')!;

  it('by tag, to your line: a mention without your nick', () => {
    const { s, chat, notes } = setup('message-tags echo-message');
    s.emit({ Kind: 'PRIVMSG', From: 'me', Target: '#general', Message: 'deploy done', Tags: { msgid: 'mine1' } });
    s.emit({ Kind: 'PRIVMSG', From: 'bob', Target: '#general', Message: 'great, thanks', Tags: { msgid: 'r1', '+draft/reply': 'mine1' } });
    expect(notes.at(-1)).toEqual({ kind: 'mention', text: 'great, thanks' });
    expect(chan(chat).mentions).toBe(1);
  });

  it('by a quote of your line (no tag)', () => {
    const { s, chat, notes } = setup();
    chat.send('#general', 'the cert renewed fine');
    chat.send('#general', 'and the backups too');
    s.emit({ Kind: 'PRIVMSG', From: 'bob', Target: '#general', Message: 'me: "the..." nice' });
    expect(notes.at(-1)!.kind).toBe('mention');
    expect(chan(chat).mentions).toBe(1);
  });

  it('by tag to someone else: not a mention', () => {
    const { s, chat, notes } = setup('message-tags');
    s.emit({ Kind: 'PRIVMSG', From: 'carol', Target: '#general', Message: 'deploy done', Tags: { msgid: 'c1' } });
    s.emit({ Kind: 'PRIVMSG', From: 'bob', Target: '#general', Message: 'great', Tags: { msgid: 'r1', '+draft/reply': 'c1' } });
    expect(notes.at(-1)!.kind).toBe('message');
    expect(chan(chat).mentions).toBe(0);
  });
});

// The join's own CHATHISTORY LATEST, answered (empty).
function answerJoinBacklog(s: ReturnType<typeof fakeSession>): void {
  s.emit({ Kind: 'BATCH', Args: ['+j', 'chathistory', '#general'] });
  s.emit({ Kind: 'BATCH', Args: ['-j'] });
}

// A tagged reply whose original isn't loaded: fetched on its own with
// CHATHISTORY AROUND, once per msgid, a few at a time.
describe('ChatService — reply context', () => {
  it('asks once per msgid and keeps what comes back', async () => {
    vi.useFakeTimers();
    try {
      const s = fakeSession();
      const raws: string[] = [];
      (s as { raw: (l: string) => void }).raw = (l) => { raws.push(l); };
      const chat = chatOn(s, 'batch chathistory message-tags');
      answerJoinBacklog(s);
      expect(chat.replyContext('#general', 'gone')).toBeUndefined();
      chat.requestReplyContext('#general', ['gone', 'gone']);
      chat.requestReplyContext('#general', ['gone']);
      vi.advanceTimersByTime(50);
      expect(raws.filter((l) => l.startsWith('CHATHISTORY AROUND'))).toEqual(['CHATHISTORY AROUND #general msgid=gone 1']);
      s.emit({ Kind: 'BATCH', Args: ['+c1', 'chathistory', '#general'] });
      s.emit({ Kind: 'PRIVMSG', From: 'bob', Target: '#general', Message: 'the original', Tags: { batch: 'c1', msgid: 'gone', time: '2026-01-01T00:00:00Z' } });
      s.emit({ Kind: 'BATCH', Args: ['-c1'] });
      await vi.runAllTimersAsync();
      expect(chat.replyContext('#general', 'gone')).toMatchObject({ from: 'bob', text: 'the original' });
      // Kept aside, not put in the conversation.
      expect(msgs(chat, '#general').some((m) => m.msgid === 'gone')).toBe(false);
      chat.requestReplyContext('#general', ['gone']);
      vi.advanceTimersByTime(50);
      expect(raws.filter((l) => l.startsWith('CHATHISTORY AROUND'))).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a server without history: not available, nothing asked', () => {
    const s = fakeSession();
    const raws: string[] = [];
    (s as { raw: (l: string) => void }).raw = (l) => { raws.push(l); };
    const chat = chatOn(s, 'message-tags');
    chat.requestReplyContext('#general', ['x']);
    expect(chat.replyContext('#general', 'x')).toBeNull();
    expect(raws.some((l) => l.startsWith('CHATHISTORY'))).toBe(false);
  });

  it('an original the server does not have: not available', async () => {
    vi.useFakeTimers();
    try {
      const s = fakeSession();
      const chat = chatOn(s, 'batch chathistory message-tags');
      answerJoinBacklog(s);
      chat.requestReplyContext('#general', ['nope']);
      vi.advanceTimersByTime(50);
      s.emit({ Kind: 'BATCH', Args: ['+c2', 'chathistory', '#general'] });
      s.emit({ Kind: 'BATCH', Args: ['-c2'] });
      await vi.runAllTimersAsync();
      expect(chat.replyContext('#general', 'nope')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
