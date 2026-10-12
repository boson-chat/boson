// A ZNC with AutoClearChanBuffer off replays its whole buffer (10k lines
// is common) on every attach, so the replay path has to stay fast and
// bounded even when the same lines arrive again.
import { describe, it, expect } from 'vitest';
import { ChatService } from './chat.service';
import type { EventListener, IrcEvent, ServerSession } from '../engine';

function session() {
  let listener: EventListener | null = null;
  const noop = () => {};
  return {
    s: {
      serverId: 'srv', join: noop, part: noop, privmsg: noop, names: noop, tagmsg: noop, list: noop, away: noop,
      nick: noop, nickservIdentify: noop, raw: noop,
      onEvent: (fn: EventListener) => { listener = fn; return () => { listener = null; }; },
      onChannelDirectory: () => noop, onServicesFramework: () => noop, servicesFramework: () => null,
    } as unknown as ServerSession,
    emit: (e: IrcEvent) => listener?.(e),
  };
}

const ev = (e: Partial<IrcEvent> & Pick<IrcEvent, 'Kind'>): IrcEvent => ({ From: '', Target: '', Message: '', Raw: '', ...e });

describe('a full-buffer replay', () => {
  it('10k lines twice: fast, no repeats, bounded', () => {
    const { s, emit } = session();
    const chat = new ChatService(s, 'Nyan', undefined, { bouncer: true });
    chat.attach();
    emit(ev({ Kind: 'CAP', Message: 'batch server-time', Args: ['ACK'] }));
    const base = Date.parse('2026-10-01T00:00:00.000Z');
    const replay = (ref: string) => {
      emit(ev({ Kind: '001', From: 'irc.znc.in', Target: 'Nyan' }));
      emit(ev({ Kind: 'JOIN', From: 'Nyan', Target: '#big' }));
      emit(ev({ Kind: 'BATCH', Args: [`+${ref}`, 'znc.in/playback', '#big'] }));
      for (let i = 0; i < 10_000; i++) {
        emit(ev({ Kind: 'PRIVMSG', From: `u${i % 7}`, Target: '#big', Message: `line ${i}`,
          Tags: { batch: ref, time: new Date(base + i * 1000).toISOString() } }));
      }
      emit(ev({ Kind: 'BATCH', Args: [`-${ref}`] }));
    };
    const t0 = performance.now();
    replay('a');
    replay('b');
    const ms = performance.now() - t0;
    const msgs = chat.getState().channels.find((c) => c.name === '#big')!.messages;
    const lines = msgs.filter((m) => m.text.startsWith('line '));
    expect(new Set(lines.map((m) => m.text)).size).toBe(lines.length);
    expect(lines[lines.length - 1]!.text).toBe('line 9999');
    expect(msgs.length).toBeLessThanOrEqual(1500);
    expect(ms).toBeLessThan(2000);
  });
});
