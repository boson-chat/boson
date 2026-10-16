import { describe, it, expect, vi, afterEach } from 'vitest';
import { ChatService } from './chat.service';
import type { EventListener, IrcEvent, ServerSession } from '../engine';

// Delivery tracking: a sent message stays pending until the engine's ACK
// (the PONG to a PING queued behind it); unconfirmed for a few seconds, the
// connection gets probed; after a reconnect, what's still pending is sent
// again once the channel is rejoined (or, for a DM, once registered).

function fakeSession() {
  let listener: EventListener | null = null;
  const f = {
    serverId: 'srv',
    sent: [] as Array<{ target: string; message: string; ack?: number }>,
    probes: 0,
    privmsg: (target: string, message: string, ack?: number) => { f.sent.push({ target, message, ack }); },
    probe: () => { f.probes++; },
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

function chatOn(session: ReturnType<typeof fakeSession>): ChatService {
  const chat = new ChatService(session as unknown as ServerSession, 'me');
  chat.attach();
  return chat;
}

const msgs = (chat: ChatService, name: string) =>
  chat.getState().channels.find((c) => c.name === name)?.messages.filter((m) => m.kind === 'message') ?? [];

afterEach(() => { vi.useRealTimers(); });

describe('ChatService — delivery', () => {
  it('a message is pending until its ACK, which confirms everything before it too', () => {
    const s = fakeSession();
    const chat = chatOn(s);
    s.emit({ Kind: 'JOIN', From: 'me', Target: '#general' });
    chat.send('#general', 'one');
    chat.send('#general', 'two');
    expect(s.sent.map((x) => x.ack)).toEqual([1, 2]);
    expect(msgs(chat, '#general').map((m) => m.pending)).toEqual([true, true]);

    s.emit({ Kind: 'ACK', Message: '2' });
    expect(msgs(chat, '#general').map((m) => m.pending)).toEqual([undefined, undefined]);
  });

  it('unconfirmed for a few seconds: the connection is probed', () => {
    vi.useFakeTimers();
    const s = fakeSession();
    const chat = chatOn(s);
    s.emit({ Kind: 'JOIN', From: 'me', Target: '#general' });
    chat.send('#general', 'hello?');
    vi.advanceTimersByTime(3000);
    expect(s.probes).toBe(0);
    vi.advanceTimersByTime(1500);
    expect(s.probes).toBe(1);
  });

  it('a confirmed message is not probed for', () => {
    vi.useFakeTimers();
    const s = fakeSession();
    const chat = chatOn(s);
    s.emit({ Kind: 'JOIN', From: 'me', Target: '#general' });
    chat.send('#general', 'fine');
    s.emit({ Kind: 'ACK', Message: '1' });
    vi.advanceTimersByTime(10_000);
    expect(s.probes).toBe(0);
  });

  it('after a reconnect, still-pending messages are sent again on rejoin, in order', () => {
    const first = fakeSession();
    const before = chatOn(first);
    first.emit({ Kind: 'JOIN', From: 'me', Target: '#general' });
    before.send('#general', 'got there');
    first.emit({ Kind: 'ACK', Message: '1' });
    before.send('#general', 'lost 1');
    before.send('#general', 'lost 2');
    before.send('bob', 'lost dm');

    const second = fakeSession();
    const after = new ChatService(second as unknown as ServerSession, 'me');
    after.seedConversations(before.exportConversations());
    after.attach();
    expect(second.sent).toEqual([]);
    second.emit({ Kind: '001', Target: 'me' });
    expect(second.sent.map((x) => x.message)).toEqual(['lost dm']);
    second.emit({ Kind: 'JOIN', From: 'me', Target: '#general' });
    expect(second.sent.map((x) => x.message)).toEqual(['lost dm', 'lost 1', 'lost 2']);
    // Not repeated on screen; confirmed by the new connection's ACK.
    expect(msgs(after, '#general').map((m) => m.text)).toEqual(['got there', 'lost 1', 'lost 2']);
    second.emit({ Kind: 'ACK', Message: String(second.sent.at(-1)!.ack) });
    expect(msgs(after, '#general').some((m) => m.pending)).toBe(false);
  });
});
