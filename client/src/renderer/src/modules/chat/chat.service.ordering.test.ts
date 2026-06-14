import { describe, it, expect } from 'vitest';
import { ChatService } from './chat.service';
import type { IrcEvent, EventListener, ServerSession } from '../engine';
import { MemoryChatHistoryStore } from '../history';

// Minimal fake session: capture the listener, expose emit(). Stubs every method
// ChatService.attach() touches.
function makeSession(): { emit(e: IrcEvent): void } {
  let listener: EventListener | null = null;
  return {
    serverId: 'srv',
    join: () => {}, part: () => {}, privmsg: () => {}, names: () => {}, tagmsg: () => {},
    list: () => {}, away: () => {}, nick: () => {}, nickservIdentify: () => {}, raw: () => {},
    onEvent: (fn: EventListener) => { listener = fn; return () => { listener = null; }; },
    onChannelDirectory: () => () => {},
    onServicesFramework: () => () => {},
    servicesFramework: () => null,
    emit: (e: IrcEvent) => listener?.(e),
  } as unknown as { emit(e: IrcEvent): void };
}

function buildChat() {
  const session = makeSession();
  const chat = new ChatService(
    session as unknown as ServerSession,
    'Nyan',
    { history: new MemoryChatHistoryStore(), scope: { userId: 'u1', serverId: 'srv' } },
  );
  chat.attach();
  return { chat, session };
}

const texts = (chat: ChatService, name: string): string[] =>
  chat.getState().channels.find((c) => c.name === name)?.messages.map((m) => m.text) ?? [];

const privmsg = (text: string, time: string): IrcEvent => ({
  Kind: 'PRIVMSG', From: 'jrmu', Target: '#t', Message: text, Tags: { time }, Raw: '',
});

describe('ChatService — message ordering', () => {
  it('inserts an out-of-order (older) arrival into chronological position', () => {
    const { chat, session } = buildChat();
    // A newer live message arrives first...
    session.emit(privmsg('newest', '2026-06-13T15:00:10.000Z'));
    // ...then older ones (e.g. delayed ZNC buffer frames) land afterward.
    session.emit(privmsg('older', '2026-06-13T15:00:00.000Z'));
    session.emit(privmsg('middle', '2026-06-13T15:00:05.000Z'));
    expect(texts(chat, '#t')).toEqual(['older', 'middle', 'newest']);
  });

  it('keeps live in-order messages as a plain append (arrival order on ties)', () => {
    const { chat, session } = buildChat();
    session.emit(privmsg('a', '2026-06-13T15:00:00.000Z'));
    session.emit(privmsg('b', '2026-06-13T15:00:00.000Z')); // same ts → stable after 'a'
    session.emit(privmsg('c', '2026-06-13T15:00:01.000Z'));
    expect(texts(chat, '#t')).toEqual(['a', 'b', 'c']);
  });
});
