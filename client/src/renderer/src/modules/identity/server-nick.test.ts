import { describe, it, expect } from 'vitest';
import { SERVER_NICK_KEY, loadServerNick, saveServerNick, serverNickKey } from './server-nick';

function memStorage(): Storage {
  const m = new Map<string, string>();
  return {
    get length() { return m.size; },
    clear: () => m.clear(),
    getItem: (k) => m.get(k) ?? null,
    key: (i) => Array.from(m.keys())[i] ?? null,
    removeItem: (k) => { m.delete(k); },
    setItem: (k, v) => { m.set(k, String(v)); },
  };
}

describe('server-nick', () => {
  it('keys by person and server', () => {
    expect(serverNickKey('srv', 'u1')).toBe('u1::srv');
    expect(serverNickKey('srv', null)).toBe('guest::srv');
    expect(serverNickKey('srv')).toBe('guest::srv');
  });

  it('remembers, replaces and forgets a pick', () => {
    const s = memStorage();
    expect(loadServerNick('u::a', s)).toBeUndefined();
    saveServerNick('u::a', 'TheLion', s);
    saveServerNick('u::b', ' other ', s);
    expect(loadServerNick('u::a', s)).toBe('TheLion');
    expect(loadServerNick('u::b', s)).toBe('other');
    saveServerNick('u::a', 'TheLion', s); // unchanged: no write needed
    saveServerNick('u::a', 'Lion', s);
    expect(loadServerNick('u::a', s)).toBe('Lion');
    saveServerNick('u::a', '', s);
    expect(loadServerNick('u::a', s)).toBeUndefined();
    saveServerNick('u::zzz', '', s); // nothing to forget
    expect(loadServerNick('u::b', s)).toBe('other');
  });

  it('copes with no storage, no key and bad data', () => {
    expect(loadServerNick('k', null)).toBeUndefined();
    saveServerNick('k', 'x', null);
    const s = memStorage();
    expect(loadServerNick('', s)).toBeUndefined();
    saveServerNick('', 'x', s);
    expect(s.getItem(SERVER_NICK_KEY)).toBeNull();
    s.setItem(SERVER_NICK_KEY, '{nope');
    expect(loadServerNick('k', s)).toBeUndefined();
    s.setItem(SERVER_NICK_KEY, '[1,2]');
    expect(loadServerNick('0', s)).toBeUndefined();
    s.setItem(SERVER_NICK_KEY, JSON.stringify({ a: 5, b: '  ', c: 'ok' }));
    expect(loadServerNick('a', s)).toBeUndefined();
    expect(loadServerNick('b', s)).toBeUndefined();
    expect(loadServerNick('c', s)).toBe('ok');
  });

  it('keeps the newest picks within its cap', () => {
    const s = memStorage();
    for (let i = 0; i < 505; i++) saveServerNick(`u::${i}`, `n${i}`, s);
    expect(loadServerNick('u::0', s)).toBeUndefined();
    expect(loadServerNick('u::504', s)).toBe('n504');
    expect(Object.keys(JSON.parse(s.getItem(SERVER_NICK_KEY)!))).toHaveLength(500);
  });

  it('survives a storage that throws on write', () => {
    const s = memStorage();
    s.setItem = () => { throw new Error('full'); };
    expect(() => saveServerNick('k', 'x', s)).not.toThrow();
  });
});
