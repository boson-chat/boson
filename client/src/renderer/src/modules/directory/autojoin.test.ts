import { describe, expect, it } from 'vitest';
import {
  MAX_AUTOJOIN, autojoinDone, channelsToAutojoin, joinsLabel, markAutojoinDone, networkKey, validAutojoinChannels,
} from './autojoin';
import { networkToServer } from './network-api';

function mem(): Pick<Storage, 'getItem' | 'setItem'> & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return { map, getItem: (k) => map.get(k) ?? null, setItem: (k, v) => { map.set(k, v); } };
}

describe('directory autojoin', () => {
  it('keeps only valid, distinct channel names', () => {
    expect(validAutojoinChannels(['#lobby', '#Lobby', 'lobby', '#a b', '#a,b', '', 3, '#help'])).toEqual(['#lobby', '#help']);
    expect(validAutojoinChannels(undefined)).toEqual([]);
    expect(validAutojoinChannels('#lobby')).toEqual([]);
    expect(validAutojoinChannels([`#${'x'.repeat(64)}`])).toEqual([]);
  });

  it('remembers per network (hostname:port, case-insensitive)', () => {
    const s = mem();
    const net = { hostname: 'IRC.Example.org', port: 6697 };
    expect(networkKey(net)).toBe('irc.example.org:6697');
    expect(autojoinDone(net, s)).toBe(false);
    markAutojoinDone(net, s);
    markAutojoinDone(net, s);
    expect(autojoinDone({ hostname: 'irc.example.org', port: 6697 }, s)).toBe(true);
    expect(autojoinDone({ hostname: 'irc.example.org', port: 6667 }, s)).toBe(false);
    expect(JSON.parse(s.map.get('boson:autojoin-done:v1')!)).toEqual(['irc.example.org:6697']);
  });

  it('treats unreadable storage as nothing done, and no storage as done', () => {
    const s = mem();
    s.map.set('boson:autojoin-done:v1', '{not json');
    expect(autojoinDone({ hostname: 'h', port: 1 }, s)).toBe(false);
    expect(autojoinDone({ hostname: 'h', port: 1 }, null)).toBe(true);
    markAutojoinDone({ hostname: 'h', port: 1 }, null); // no throw
  });

  it('joins only what we are not in, at most MAX_AUTOJOIN', () => {
    expect(channelsToAutojoin(['#Lobby', '#help'], ['#lobby', '#other'])).toEqual(['#help']);
    expect(channelsToAutojoin(['#lobby'], [])).toEqual(['#lobby']);
    const many = Array.from({ length: 20 }, (_, i) => `#c${i}`);
    expect(channelsToAutojoin(many, [])).toHaveLength(MAX_AUTOJOIN);
  });

  it('labels the card', () => {
    expect(joinsLabel(undefined)).toBeNull();
    expect(joinsLabel([])).toBeNull();
    expect(joinsLabel(['#lobby'])).toBe('Joins #lobby');
    expect(joinsLabel(['#lobby', '#help'])).toBe('Joins #lobby, #help');
    expect(joinsLabel(['#a', '#b', '#c', '#d'])).toBe('Joins #a, #b +2');
  });

  it('reads autojoin_channels and channels off a /v1 listing (absent on old directories)', () => {
    const s = networkToServer({ id: 'n', hostname: 'h', autojoin_channels: ['#lobby', 'bad'], channels: ['#lobby', '#help'] });
    expect(s.autojoin_channels).toEqual(['#lobby']);
    expect(s.channels).toEqual(['#lobby', '#help']);
    const old = networkToServer({ id: 'n', hostname: 'h' });
    expect('autojoin_channels' in old).toBe(false);
    expect('channels' in old).toBe(false);
  });
});
