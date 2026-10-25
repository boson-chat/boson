import { describe, it, expect } from 'vitest';
import { applyWhoisReply, formatMask } from './whois';
import type { WhoisInfo } from './chat.types';

const base: WhoisInfo = { nick: 'bob', loading: true, requestedAt: 0 };

describe('applyWhoisReply', () => {
  it('reads an oper line, a bot line and the real host', () => {
    let w = applyWhoisReply(base, '313', ['bob', 'is a Network Administrator'], 'is a Network Administrator');
    w = applyWhoisReply(w, '335', ['bob', 'is a Bot'], 'is a Bot');
    w = applyWhoisReply(w, '338', ['bob', '203.0.113.7', 'actually using host'], 'actually using host');
    expect(w).toMatchObject({ oper: 'is a Network Administrator', bot: true, actualHost: '203.0.113.7' });
  });

  it('reads 378 "is connecting from"', () => {
    const w = applyWhoisReply(base, '378', ['bob', 'is connecting from *@host.example 203.0.113.7'], 'is connecting from *@host.example 203.0.113.7');
    expect(w.actualHost).toBe('*@host.example 203.0.113.7');
  });

  it('takes an idle time without a signon time', () => {
    const w = applyWhoisReply(base, '317', ['bob', '42', 'seconds idle'], 'seconds idle');
    expect(w.idleSeconds).toBe(42);
    expect(w.signonAt).toBeUndefined();
  });

  it('collects channels over several 319 lines without repeats', () => {
    let w = applyWhoisReply(base, '319', ['bob', '#a #b'], '#a #b');
    w = applyWhoisReply(w, '319', ['bob', '#b +#c'], '#b +#c');
    expect(w.channels).toEqual(['#a', '#b', '+#c']);
  });

  it('leaves the input untouched', () => {
    applyWhoisReply(base, '318', ['bob'], '');
    expect(base.loading).toBe(true);
  });
});

describe('formatMask', () => {
  it('stars what is unknown', () => {
    expect(formatMask('bob', '~b', 'h.example')).toBe('bob!~b@h.example');
    expect(formatMask('bob', undefined, 'h')).toBe('bob!*@h');
  });
});
