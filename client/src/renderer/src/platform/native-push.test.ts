import { describe, expect, it } from 'vitest';
import { nativePushBridge, toPushError } from './native-push';
import { PushError } from '../modules/push/push.types';

function calls(answers: Record<string, unknown>) {
  const made: Array<[string, unknown[]]> = [];
  const handlers = new Map<string, (d: unknown) => void>();
  return {
    made,
    emit: (ev: string, d: unknown) => handlers.get(ev)?.(d),
    c: {
      call: async (m: string, ...args: unknown[]) => {
        made.push([m, args]);
        const a = answers[m];
        if (a instanceof Error) throw a;
        return a;
      },
      on: (ev: string, fn: (d: unknown) => void) => { handlers.set(ev, fn); return () => handlers.delete(ev); },
    },
  };
}

describe('nativePushBridge', () => {
  it('subscribes through PushService and reads permission from NotifyService', async () => {
    const f = calls({
      'main.PushService.Subscribe': { endpoint: 'https://push.boson.chat/v1/push/x', p256dh: 'P', auth: 'A' },
      'main.NotifyService.Permission': 'granted',
      'main.PushService.Supported': '',
      'main.PushService.RelayFor': 'https://push.boson.chat',
    });
    const b = nativePushBridge('ios', f.c);
    expect(b.needsRelay).toBe(true);
    expect(await b.supported()).toBeNull();
    expect(await b.permission()).toBe('granted');
    expect(await b.relayFor!('irc.example.org')).toBe('https://push.boson.chat');
    expect(await b.subscribe({ serverId: 's1', serverName: 'S', host: 'irc.example.org', vapid: 'V' }))
      .toEqual({ endpoint: 'https://push.boson.chat/v1/push/x', p256dh: 'P', auth: 'A' });
    expect(f.made).toContainEqual(['main.PushService.Subscribe', ['s1', 'S', 'irc.example.org', 'V']]);
    await b.syncPrefs({ v: 1, enabled: true, mentions: true, directMessages: false, servers: {}, levels: {} });
    expect(f.made.at(-1)![1][0]).toBe('{"v":1,"enabled":true,"mentions":true,"directMessages":false,"servers":{},"levels":{}}');
  });

  it('turns Go errors into coded PushErrors', async () => {
    const f = calls({ 'main.PushService.Subscribe': new Error('{"message":"no-relay: the server names no push relay"}') });
    const b = nativePushBridge('android', f.c);
    await expect(b.subscribe({ serverId: 's', serverName: 'S', host: 'h', vapid: 'v' })).rejects.toEqual(new PushError('no-relay', 'the server names no push relay'));
    expect(toPushError(new Error('denied: Notifications are off')).code).toBe('denied');
    expect(toPushError(new Error('boom')).code).toBe('failed');
  });

  it('passes taps on, live and from a cold start', async () => {
    const f = calls({ 'main.PushService.ConsumeOpen': { serverId: 's1', conversation: '#team' } });
    const b = nativePushBridge('ios', f.c);
    const got: string[] = [];
    b.onOpen((s, c) => got.push(`${s} ${c}`));
    f.emit('push:open', [{ serverId: 's2', conversation: 'alice' }]);
    expect(got).toEqual(['s2 alice']);
    expect(await b.consumeOpen()).toEqual({ serverId: 's1', conversation: '#team' });
  });
});
