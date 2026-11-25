import { describe, expect, it } from 'vitest';
import type { ChatMessage } from '../../modules/chat/chat.types';
import { collectMyDms, lastReceivedAt } from './my-dms';

let n = 0;
const msg = (from: string, timestamp: number, kind: ChatMessage['kind'] = 'message'): ChatMessage =>
  ({ id: String(n++), kind, from, text: 'x', timestamp }) as ChatMessage;
const ch = (name: string, messages: ChatMessage[], unread = 0) => ({ name, unread, mentions: 0, messages });

describe('lastReceivedAt', () => {
  it('is the newest line from the other side, ignoring our replies and joins', () => {
    expect(lastReceivedAt([msg('mox', 10), msg('me', 50), msg('', 60, 'system')], 'Me')).toBe(10);
  });
  it('falls back to our newest line, then 0', () => {
    expect(lastReceivedAt([msg('me', 5), msg('me', 7)], 'me')).toBe(7);
    expect(lastReceivedAt([], 'me')).toBe(0);
  });
});

describe('collectMyDms', () => {
  it('lists people across servers newest received first, without channels, services or servers', () => {
    const dms = collectMyDms([
      { serverId: 'a', serverName: 'A', myNick: 'me', channels: [
        ch('#dev', [msg('nova', 999)]),
        ch('~server', [msg('irc', 999)]),
        ch('old', [msg('old', 100)]),
        ch('NickServ', [msg('NickServ', 900)]),
        ch('magnet.rizon.net', [msg('magnet.rizon.net', 900)]),
        ch('*status', [msg('*status', 900)]),
      ] },
      { serverId: 'b', serverName: 'B', myNick: 'me', channels: [
        ch('new', [msg('new', 300), msg('me', 400)], 2),
        ch('mid', [msg('mid', 200)]),
      ] },
    ]);
    expect(dms.map((d) => d.name)).toEqual(['new', 'mid', 'old']);
    expect(dms[0]).toEqual({ serverId: 'b', serverName: 'B', name: 'new', unread: 2, mentions: 0 });
  });
  it('keeps the original order for ties', () => {
    const dms = collectMyDms([{ serverId: 'a', serverName: 'A', myNick: 'me', channels: [ch('x', []), ch('y', [])] }]);
    expect(dms.map((d) => d.name)).toEqual(['x', 'y']);
  });
});
