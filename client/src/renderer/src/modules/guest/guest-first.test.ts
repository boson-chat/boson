import { afterEach, describe, expect, it } from 'vitest';
import {
  friendlyNick, guestAutojoinChannels, guestFirstOn, guestNickIsAuto, guestNickStep, landingChannel, lastGuestNick,
  parseGuestFirstLink, rememberGuestNick, setGuestLanding, takeGuestLanding,
} from './guest-first';
import { sanitizeIrcNick } from '../identity/nick';

function seq(...xs: number[]): () => number {
  let i = 0;
  return () => xs[i++ % xs.length]!;
}

afterEach(() => { localStorage.clear(); setGuestLanding(null); });

describe('friendlyNick', () => {
  it('is an adjective and an animal, IRC-valid and at most 16 characters', () => {
    expect(friendlyNick(seq(0.99, 0.51))).toBe('ZestyKiwi');
    for (let i = 0; i < 500; i++) {
      const n = friendlyNick(Math.random, i % 3);
      expect(n).toMatch(/^[A-Z][a-z]+[A-Z][a-z]*\d{0,2}$/);
      expect(n.length).toBeLessThanOrEqual(16);
      expect(sanitizeIrcNick(n)).toBe(n);
    }
  });

  it('adds two digits after the first try', () => {
    expect(friendlyNick(seq(0.99, 0.51, 0.5), 1)).toBe('ZestyKiwi55');
  });
});

describe('the nick kept on this device', () => {
  it('remembers the last guest nick and whether it was made for them', () => {
    expect(lastGuestNick()).toBeNull();
    rememberGuestNick('ZestyKiwi', true);
    expect(lastGuestNick()).toEqual({ nick: 'ZestyKiwi', auto: true });
    expect(guestNickIsAuto('zestykiwi')).toBe(true);
    expect(guestNickIsAuto('Other')).toBe(false);
    rememberGuestNick('ada', false);
    expect(guestNickIsAuto('ada')).toBe(false);
    localStorage.setItem('boson:guest:last-nick:v1', '{bad');
    expect(lastGuestNick()).toBeNull();
  });
});

describe('settings', () => {
  const cfg = {
    guest_first: true, guest_access: true, guest_first_channel: null,
    channels: [
      { name: '#news' },
      { name: '#staff', autojoin: true, restricted: true },
      { name: '#IRCForever', autojoin: true },
      { name: '#help', autojoin: true },
    ],
  };

  it('is on only with guest access', () => {
    expect(guestFirstOn(cfg)).toBe(true);
    expect(guestFirstOn({ ...cfg, guest_access: false })).toBe(false);
    expect(guestFirstOn({ guest_access: true })).toBe(false);
    expect(guestFirstOn(null)).toBe(false);
  });

  it('auto-joins the channels guests may join', () => {
    expect(guestAutojoinChannels(cfg)).toEqual(['#IRCForever', '#help']);
    expect(guestAutojoinChannels(null)).toEqual([]);
  });

  it('lands on the link channel when allowed, else guest_first_channel, else the first auto-join', () => {
    expect(landingChannel(cfg)).toBe('#IRCForever');
    expect(landingChannel({ ...cfg, guest_first_channel: '#help' })).toBe('#help');
    expect(landingChannel(cfg, '#news')).toBe('#news');
    expect(landingChannel(cfg, '#elsewhere')).toBe('#elsewhere');
    // Restricted to roles, or not a channel: the default instead.
    expect(landingChannel(cfg, '#STAFF')).toBe('#IRCForever');
    expect(landingChannel(cfg, 'nope')).toBe('#IRCForever');
    expect(landingChannel({ channels: [] })).toBeNull();
  });
});

describe('parseGuestFirstLink', () => {
  it('reads nick, channel (query or fragment) and join', () => {
    expect(parseGuestFirstLink('?nick=ada&channel=%23help&join=1')).toEqual({ nick: 'ada', channel: '#help', join: true });
    expect(parseGuestFirstLink('?channel=help')).toEqual({ nick: null, channel: '#help', join: false });
    expect(parseGuestFirstLink('', '#IRCForever')).toEqual({ nick: null, channel: '#IRCForever', join: false });
    expect(parseGuestFirstLink('?join=true&nick=9 lives')).toEqual({ nick: '_9_lives', channel: null, join: true });
    expect(parseGuestFirstLink('?channel=%23a%20b&join=0')).toEqual({ nick: null, channel: null, join: false });
    expect(parseGuestFirstLink('?nick=%20')).toEqual({ nick: null, channel: null, join: false });
  });
});

describe('landing', () => {
  it('is taken once', () => {
    setGuestLanding({ focus: '#a', channels: ['#a', '#b'] });
    expect(takeGuestLanding()).toEqual({ focus: '#a', channels: ['#a', '#b'] });
    expect(takeGuestLanding()).toBeNull();
  });
});

describe('guestNickStep', () => {
  it('tries a fresh nick when the made one was taken, and keeps the first the network takes', () => {
    expect(guestNickStep({ guestNick: 'ZestyKiwi', current: 'ZestyKiwi', tried: [], attempts: 0 })).toBeNull();
    expect(guestNickStep({ guestNick: 'ZestyKiwi', current: 'ZestyKiwi_', tried: [], attempts: 0 })).toEqual({ kind: 'try' });
    expect(guestNickStep({ guestNick: 'ZestyKiwi', current: 'ZestyKiwi_', tried: ['BraveOtter12'], attempts: 1 })).toEqual({ kind: 'try' });
    expect(guestNickStep({ guestNick: 'ZestyKiwi', current: 'braveotter12', tried: ['BraveOtter12'], attempts: 1 }))
      .toEqual({ kind: 'keep', nick: 'braveotter12' });
    expect(guestNickStep({ guestNick: 'ZestyKiwi', current: 'ZestyKiwi_', tried: [], attempts: 5 })).toBeNull();
    expect(guestNickStep({ guestNick: 'ZestyKiwi', current: '', tried: [], attempts: 0 })).toBeNull();
  });
});
