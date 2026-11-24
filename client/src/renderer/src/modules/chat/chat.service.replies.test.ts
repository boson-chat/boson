import { describe, it, expect } from 'vitest';
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
