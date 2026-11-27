import { describe, expect, it } from 'vitest';
import { cleanText, parseLine, parsePush, pushText } from './payload';

describe('parseLine', () => {
  it('reads tags, source, command and params', () => {
    const l = parseLine('@time=2026-11-27T10:00:00.000Z;msgid=abc;account=alice :alice!a@host PRIVMSG #team :hi bob');
    expect(l).toEqual({
      tags: { time: '2026-11-27T10:00:00.000Z', msgid: 'abc', account: 'alice' },
      source: 'alice!a@host', command: 'PRIVMSG', params: ['#team', 'hi bob'],
    });
  });
  it('unescapes tag values', () => {
    expect(parseLine('@a=x\\sy\\:z\\\\ PING')?.tags['a']).toBe('x y;z\\');
  });
  it('rejects garbage', () => {
    expect(parseLine('')).toBeNull();
    expect(parseLine('@tags-only')).toBeNull();
  });
});

describe('parsePush', () => {
  it('a test push is a ping', () => {
    expect(parsePush('PING webpush')).toEqual({ type: 'ping' });
  });
  it('a channel line is a mention', () => {
    expect(parsePush('@msgid=m1;time=2026-11-27T10:00:00.000Z :thelion!u@h PRIVMSG #team :bob: look')).toEqual({
      type: 'message', kind: 'mention', nick: 'thelion', conversation: '#team', text: 'bob: look',
      action: false, notice: false, msgid: 'm1', time: '2026-11-27T10:00:00.000Z',
    });
  });
  it('a line to us is a DM, opening the sender', () => {
    const m = parsePush(':alice!u@h PRIVMSG bob :hey');
    expect(m).toMatchObject({ type: 'message', kind: 'dm', nick: 'alice', conversation: 'alice', text: 'hey' });
  });
  it('/me and notices', () => {
    expect(parsePush(':alice!u@h PRIVMSG bob :\x01ACTION waves\x01')).toMatchObject({ action: true, text: 'waves' });
    expect(parsePush(':alice!u@h NOTICE bob :psst')).toMatchObject({ notice: true, kind: 'dm' });
  });
  it('ignores CTCPs, server notices and unknown commands', () => {
    expect(parsePush(':alice!u@h PRIVMSG bob :\x01VERSION\x01').type).toBe('other');
    expect(parsePush(':irc.example NOTICE bob :server says').type).toBe('other');
    expect(parsePush(':alice!u@h JOIN #x').type).toBe('other');
  });
  it('MARKREAD is a read receipt', () => {
    expect(parsePush('@time=x :irc.example MARKREAD #team timestamp=2026-11-27T10:00:00.000Z'))
      .toEqual({ type: 'read', target: '#team', time: '2026-11-27T10:00:00.000Z' });
    expect(parsePush(':irc.example MARKREAD alice timestamp=*')).toEqual({ type: 'read', target: 'alice' });
  });
});

describe('pushText', () => {
  it('"<nick> in #channel" and "<nick>" for DMs', () => {
    const ch = parsePush(':thelion!u@h PRIVMSG #team :\x02bob\x02: \x0304look\x03 here');
    if (ch.type !== 'message') throw new Error('no');
    expect(pushText(ch, 's1', 'Boson')).toEqual({ title: 'thelion in #team', subtitle: 'Boson', body: 'bob: look here', tag: 's1:#team' });
    const dm = parsePush(':Alice!u@h PRIVMSG bob :\x01ACTION waves\x01');
    if (dm.type !== 'message') throw new Error('no');
    expect(pushText(dm, 's1', 'Boson')).toMatchObject({ title: 'Alice', body: '* Alice waves', tag: 's1:alice' });
  });
  it('clamps long text', () => {
    expect(cleanText('x'.repeat(300)).length).toBe(180);
  });
});
