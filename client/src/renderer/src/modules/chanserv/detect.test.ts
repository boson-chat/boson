import { describe, it, expect } from 'vitest';
import { detectChanServDialect, dialectFromNetwork, dialectFromReplies, dialectFromVersion } from './detect';

describe('dialectFromVersion (RPL_MYINFO)', () => {
  it.each([
    ['ergo-2.19.1', 'ergo'],
    ['oragono-2.0.0', 'ergo'],
    ['u2.10.12.19', 'x'],
    ['u2.10.12.10+snircd(1.3.4a)', 'q'],
    ['u2.10.H.10.123', 'q'],
    ['bahamut-2.2.4', 'generic'],
    ['UnrealIRCd-6.1.8', null],
    ['InspIRCd-3', null],
    ['solanum-1.0-dev', null],
    [undefined, null],
  ] as const)('%s → %s', (v, want) => {
    expect(dialectFromVersion(v)).toBe(want);
  });
});

describe('dialectFromNetwork (ISUPPORT NETWORK=)', () => {
  it.each([
    ['UnderNet', 'x'], ['QuakeNet', 'q'], ['DALnet', 'generic'], ['Libera.Chat', 'atheme'], ['OFTC', null], [undefined, null],
  ] as const)('%s → %s', (n, want) => {
    expect(dialectFromNetwork(n)).toBe(want);
  });
});

describe('dialectFromReplies (ChanServ reply shapes)', () => {
  it('recognises each package\'s INFO header', () => {
    expect(dialectFromReplies(['Information for channel \x02#dev\x02:'])).toBe('anope');
    expect(dialectFromReplies(["Channel \x02#dev\x02 isn't registered."])).toBe('anope');
    expect(dialectFromReplies(['Information on \x02#dev\x02:'])).toBe('atheme');
    expect(dialectFromReplies(['\x02*** End of Info ***\x02'])).toBe('atheme');
    expect(dialectFromReplies(['Channel #dev is not registered'])).toBe('ergo');
    expect(dialectFromReplies(['Unknown command. To see available commands, run: /CS HELP'])).toBe('ergo');
  });
  it('recognises the brand in a VERSION reply', () => {
    expect(dialectFromReplies(['Anope-2.0.20 -- build #1'])).toBe('anope');
    expect(dialectFromReplies(['atheme 7.2.12. https://atheme.github.io/'])).toBe('atheme');
  });
  it('ignores what it does not know', () => {
    expect(dialectFromReplies(['Hello!', 'Informationen für #dev:'])).toBeNull();
  });
});

describe('detectChanServDialect', () => {
  it('an Ergo server is always Ergo, whatever else is said', () => {
    expect(detectChanServDialect({ version: 'ergo-2.19.1', framework: 'anope', network: 'Libera.Chat' })).toBe('ergo');
  });
  it('the engine verdict wins over network guesses', () => {
    expect(detectChanServDialect({ framework: 'anope', network: 'Libera.Chat', version: 'solanum-1.0' })).toBe('anope');
    expect(detectChanServDialect({ framework: 'atheme', version: 'InspIRCd-3' })).toBe('atheme');
  });
  it('ircu networks map to their channel bot even before the engine settles', () => {
    expect(detectChanServDialect({ version: 'u2.10.12.19', network: 'UnderNet' })).toBe('x');
    expect(detectChanServDialect({ version: 'u2.10.12.10+snircd(1.3.4a)', network: 'QuakeNet' })).toBe('q');
  });
  it('falls back to the network, then reply shapes', () => {
    expect(detectChanServDialect({ network: 'DALnet', version: 'bahamut-2.2.4', framework: 'unknown' })).toBe('generic');
    expect(detectChanServDialect({ network: 'Libera.Chat', version: 'solanum-1.0' })).toBe('atheme');
    expect(detectChanServDialect({ chanservLines: ['Information on #x:'], version: 'solanum-1.0' })).toBe('atheme');
  });
  it('undecided until the engine says "unknown", then generic read-only', () => {
    expect(detectChanServDialect({ version: 'UnrealIRCd-6.1.8' })).toBeNull();
    expect(detectChanServDialect({ version: 'UnrealIRCd-6.1.8', framework: 'unknown' })).toBe('generic');
  });
});
