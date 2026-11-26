import { describe, it, expect } from 'vitest';
import type { ChatMessage } from './chat.types';
import {
  QUOTE_MAX, addresses, parseTextReply, quotableText, replyBody, replyPrefix, resolveTextReply, withoutReplyPrefix,
} from './replies';

let n = 0;
const m = (from: string, text: string, over: Partial<ChatMessage> = {}): ChatMessage => ({
  id: `id${++n}`, kind: 'message', from, text, timestamp: n, ...over,
});

describe('replyPrefix (the text form a reply is sent with)', () => {
  const a = m('bob', 'anyone know why the build fails on arm?');
  const b = m('bob', 'also is the meeting at 3 or 4?');
  const c = m('bob', 'anyone around?');
  const convo = [a, m('carol', 'hi'), b, c, m('carol', 'morning')];

  it('the examples: older lines get the shortest unique quote, the latest none', () => {
    expect(replyPrefix(a, convo)).toBe('bob: "anyone know..." ');
    expect(replyPrefix(b, convo)).toBe('bob: "also..." ');
    expect(replyPrefix(c, convo)).toBe('bob: ');
  });

  it('compares without case or punctuation', () => {
    const x = m('bob', 'Hello, world! how are you');
    const y = m('bob', 'hello world... fine');
    const z = m('bob', 'later');
    expect(replyPrefix(x, [x, y, z])).toBe('bob: "Hello, world! how..." ');
  });

  it('skips a leading `someone:` in the quoted line', () => {
    const x = m('bob', 'carol: the cert renewed fine');
    const y = m('bob', 'ok');
    expect(replyPrefix(x, [x, y])).toBe('bob: "the..." ');
  });

  it('skips the quote of a line that was itself a reply', () => {
    const x = m('bob', 'carol: "is it..." yes, since 4pm');
    const y = m('bob', 'ok');
    expect(replyPrefix(x, [x, y])).toBe('bob: "yes..." ');
  });

  it('drops trailing punctuation and double quotes from the quote', () => {
    const x = m('bob', 'wait, "really"? no');
    const y = m('bob', 'ok');
    expect(replyPrefix(x, [x, y])).toBe('bob: "wait..." ');
  });

  it('uses ASCII dots, never an ellipsis character', () => {
    const x = m('bob', 'one two');
    expect(replyPrefix(x, [x, m('bob', 'three')])).not.toContain('…');
  });

  it('caps the quote: a distinctive word from inside instead', () => {
    const x = m('bob', 'the build on the staging box broke again with libssl');
    const y = m('bob', 'the build on the staging box broke again today');
    const z = m('bob', 'ok');
    const p = replyPrefix(x, [x, y, z]);
    expect(p).toBe('bob: "...libssl..." ');
  });

  it('a line said twice: its first words, capped', () => {
    const x = m('bob', 'ping');
    const y = m('bob', 'ping');
    const z = m('bob', 'ok');
    expect(replyPrefix(x, [x, y, z])).toBe('bob: "ping..." ');
  });

  it('a very long first word is cut to the cap', () => {
    const url = 'https://example.com/a/very/long/path/to/something';
    const x = m('bob', url);
    const y = m('bob', url);
    const p = replyPrefix(x, [x, y, m('bob', 'ok')]);
    const quote = /"(.*)\.\.\."/.exec(p)![1]!;
    expect(quote.length).toBeLessThanOrEqual(QUOTE_MAX);
  });

  it('only looks at the sender\'s lines, and only the last 200', () => {
    const x = m('bob', 'deploy is green');
    const filler = Array.from({ length: 210 }, () => m('carol', 'deploy is red'));
    const old = m('bob', 'deploy is red');
    expect(replyPrefix(x, [old, ...filler.slice(0, 5), x, ...filler, m('bob', 'later')])).toBe('bob: "deploy..." ');
  });

  it('joins and system lines do not count as their latest', () => {
    const x = m('bob', 'brb');
    expect(replyPrefix(x, [x, m('bob', 'bob has quit', { kind: 'quit' })])).toBe('bob: ');
  });

  it('a target not in the list is quoted', () => {
    const x = m('bob', 'old one');
    expect(replyPrefix(x, [m('bob', 'new one')])).toBe('bob: "old..." ');
  });

  it('an empty line answers with just the nick', () => {
    const x = m('bob', 'carol:');
    expect(replyPrefix(x, [x, m('bob', 'later')])).toBe('bob: ');
  });
});

describe('parseTextReply', () => {
  it('reads the forms', () => {
    expect(parseTextReply('bob: yep')).toMatchObject({ nick: 'bob', prefixLength: 5 });
    expect(parseTextReply('bob: yep')!.quote).toBeUndefined();
    expect(parseTextReply('bob: "anyone know..." libssl')).toMatchObject({
      nick: 'bob', quote: { words: ['anyone', 'know'], inner: false }, prefixLength: 22,
    });
    expect(parseTextReply('bob: "...libssl..." that')!.quote).toEqual({ words: ['libssl'], inner: true });
    expect(parseTextReply('bob: "anyone…" yes')!.quote).toEqual({ words: ['anyone'], inner: false });
    expect(parseTextReply('[m]x|y: hi')!.nick).toBe('[m]x|y');
  });

  it('is not fooled by URLs, times or plain text', () => {
    expect(parseTextReply('https://example.com')).toBeNull();
    expect(parseTextReply('at 10:30 ok')).toBeNull();
    expect(parseTextReply('hello there')).toBeNull();
    expect(parseTextReply('bob:yep')).toBeNull();
    expect(parseTextReply('bob: "just a quote" said')!.quote).toBeUndefined();
  });
});

describe('resolveTextReply (receive)', () => {
  it('a quote links to the newest earlier line starting with it', () => {
    const a = m('bob', 'anyone know why the build fails on arm?');
    const b = m('bob', 'anyone around?');
    const r = m('carol', 'bob: "anyone know..." libssl-dev');
    expect(resolveTextReply(r, [a, b])).toEqual({ id: a.id, guessed: false });
  });

  it('the inner form matches a word anywhere', () => {
    const a = m('bob', 'the build on staging broke with libssl');
    const b = m('bob', 'the build on staging broke today');
    expect(resolveTextReply(m('carol', 'bob: "...libssl..." pin it'), [a, b])).toEqual({ id: a.id, guessed: false });
  });

  it('a cut-off last word still matches', () => {
    const a = m('bob', 'https://example.com/a/very/long/path');
    expect(resolveTextReply(m('carol', 'bob: "https://example.org..." ok'), [a])).toBeNull();
    expect(resolveTextReply(m('carol', 'bob: "https://example.com/a/v..." ok'), [a])).toEqual({ id: a.id, guessed: false });
  });

  it('just `nick:` is a guess: their latest line', () => {
    const a = m('bob', 'one');
    const b = m('bob', 'two');
    expect(resolveTextReply(m('carol', 'Bob: yes'), [a, b, m('dave', 'x')])).toEqual({ id: b.id, guessed: true });
  });

  it('nothing when the nick never spoke, the quote matches nothing, or it\'s tagged', () => {
    const a = m('bob', 'one');
    expect(resolveTextReply(m('carol', 'note: this is fine'), [a])).toBeNull();
    expect(resolveTextReply(m('carol', 'bob: "seven..." hm'), [a])).toBeNull();
    expect(resolveTextReply(m('carol', 'bob: yes', { replyTo: 'x' }), [a])).toBeNull();
    expect(resolveTextReply(m('bob', 'bob: talking to myself'), [a])).toBeNull();
    expect(resolveTextReply(m('carol', 'bob: hi', { kind: 'notice' }), [a])).toBeNull();
  });

  it('round-trips with replyPrefix', () => {
    const lines = [
      m('bob', 'anyone know why the build fails on arm?'),
      m('bob', 'also is the meeting at 3 or 4?'),
      m('bob', 'anyone around?'),
      m('bob', 'the build on staging broke with libssl and openssl'),
      m('bob', 'the build on staging broke with libssl and gnutls'),
      m('bob', 'last'),
    ];
    for (const t of lines) {
      const sent = m('carol', `${replyPrefix(t, lines)}answer`);
      const got = resolveTextReply(sent, lines);
      expect(got?.id, sent.text).toBe(t.id);
    }
  });
});

describe('display helpers', () => {
  it('replyBody hides the prefix when it names the original\'s author', () => {
    const parent = m('bob', 'q');
    expect(replyBody(m('carol', 'bob: "q..." answer', { replyTo: 'p' }), parent)).toBe('answer');
    expect(replyBody(m('carol', 'bob: answer', { replyTo: 'p' }), parent)).toBe('answer');
    expect(replyBody(m('carol', 'dave: answer', { replyTo: 'p' }), parent)).toBe('dave: answer');
    expect(replyBody(m('carol', 'bob: answer', { replyGuess: true }), parent)).toBe('bob: answer');
    expect(replyBody(m('carol', 'bob: answer'), null)).toBe('bob: answer');
    expect(replyBody(m('carol', 'bob: '), parent)).toBe('bob: ');
  });

  it('withoutReplyPrefix, quotableText, addresses', () => {
    expect(withoutReplyPrefix('bob: "x..." y')).toBe('y');
    expect(quotableText('\x02bob\x02: hi')).toBe('hi');
    expect(addresses('Bob: hi', 'bob')).toBe(true);
    expect(addresses('bob, hi', 'bob')).toBe(true);
    expect(addresses('bobby: hi', 'bob')).toBe(false);
  });
});
