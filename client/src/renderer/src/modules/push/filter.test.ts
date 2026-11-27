import { describe, expect, it } from 'vitest';
import { cleanPrefs, DEFAULT_PUSH_PREFS, shouldShowPush } from './filter';
import { parsePush } from './payload';

const dm = parsePush(':alice!u@h PRIVMSG bob :hey');
const mention = parsePush(':alice!u@h PRIVMSG #team :bob: hey');

describe('shouldShowPush', () => {
  it('shows DMs and mentions by default', () => {
    expect(shouldShowPush(dm, 's1', null)).toBe(true);
    expect(shouldShowPush(mention, 's1', DEFAULT_PUSH_PREFS)).toBe(true);
  });
  it('never shows pings or read receipts', () => {
    expect(shouldShowPush(parsePush('PING webpush'), 's1', null)).toBe(false);
    expect(shouldShowPush(parsePush(':s MARKREAD #team timestamp=*'), 's1', null)).toBe(false);
  });
  it('follows the switches', () => {
    expect(shouldShowPush(dm, 's1', { ...DEFAULT_PUSH_PREFS, enabled: false })).toBe(false);
    expect(shouldShowPush(dm, 's1', { ...DEFAULT_PUSH_PREFS, directMessages: false })).toBe(false);
    expect(shouldShowPush(mention, 's1', { ...DEFAULT_PUSH_PREFS, mentions: false })).toBe(false);
  });
  it('a muted channel or DM, or a server set to nothing, stays quiet', () => {
    expect(shouldShowPush(mention, 's1', { ...DEFAULT_PUSH_PREFS, levels: { 's1\0#team': 'nothing' } })).toBe(false);
    expect(shouldShowPush(mention, 's2', { ...DEFAULT_PUSH_PREFS, levels: { 's1\0#team': 'nothing' } })).toBe(true);
    expect(shouldShowPush(dm, 's1', { ...DEFAULT_PUSH_PREFS, servers: { s1: { dms: 'nothing' } } })).toBe(false);
    expect(shouldShowPush(mention, 's1', { ...DEFAULT_PUSH_PREFS, servers: { s1: { channels: 'nothing' } } })).toBe(false);
    // The conversation's own level wins over the server's.
    expect(shouldShowPush(dm, 's1', { ...DEFAULT_PUSH_PREFS, servers: { s1: { dms: 'nothing' } }, levels: { 's1\0alice': 'all' } })).toBe(true);
  });
});

describe('cleanPrefs', () => {
  it('keeps what is valid and defaults the rest', () => {
    expect(cleanPrefs({ enabled: false, servers: { s: { channels: 'loud', dms: 'nothing' } }, levels: { a: 'all', b: 7 } }))
      .toEqual({ v: 1, enabled: false, mentions: true, directMessages: true, servers: { s: { dms: 'nothing' } }, levels: { a: 'all' } });
    expect(cleanPrefs(null)).toEqual(DEFAULT_PUSH_PREFS);
  });
});
