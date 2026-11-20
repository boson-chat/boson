import { describe, it, expect } from 'vitest';
import { bouncerNetworkNames, parseBouncerAttrs, parseBouncerNetworkArgs } from './bouncer-networks.parse';

describe('parseBouncerAttrs', () => {
  it('decodes tag-style attributes with escapes', () => {
    expect(parseBouncerAttrs('name=My\\sNet;host=irc.example.org;port=6697;tls=1;realname=a\\:b\\\\c'))
      .toEqual({ name: 'My Net', host: 'irc.example.org', port: '6697', tls: '1', realname: 'a;b\\c' });
  });

  it('maps keys without a value to empty and skips empty parts', () => {
    expect(parseBouncerAttrs('error;;state=')).toEqual({ error: '', state: '' });
  });
});

describe('parseBouncerNetworkArgs', () => {
  it('reads BOUNCER NETWORK lines', () => {
    expect(parseBouncerNetworkArgs(['NETWORK', '7', 'name=Libera;state=connected']))
      .toEqual({ id: '7', attrs: { name: 'Libera', state: 'connected' } });
  });

  it('ignores removals, other subcommands and short lines', () => {
    expect(parseBouncerNetworkArgs(['NETWORK', '7', '*'])).toBeNull();
    expect(parseBouncerNetworkArgs(['ADDNETWORK', '7'])).toBeNull();
    expect(parseBouncerNetworkArgs(['NETWORK', '7'])).toBeNull();
    expect(parseBouncerNetworkArgs(undefined)).toBeNull();
  });
});

describe('bouncerNetworkNames', () => {
  it('takes the name attribute, falls back to the netid and dedupes ignoring case', () => {
    expect(bouncerNetworkNames([
      { id: '1', attrs: { name: 'Libera' } },
      { id: '2', attrs: { name: 'OFTC' } },
      { id: '3', attrs: { name: 'libera' } },
      { id: '4', attrs: { host: 'irc.example.org' } },
    ])).toEqual(['Libera', 'OFTC', '4']);
  });
});
