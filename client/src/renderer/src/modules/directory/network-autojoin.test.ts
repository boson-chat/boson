import { describe, expect, it } from 'vitest';
import { autojoinWho, markNetworkAutojoined, networkAutojoinChannels, networkAutojoined, networkChannelsToJoin } from './network-autojoin';

function mem() {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v); } };
}

const server = { hostname: 'irc.forever.test', port: 6697 };

describe('network auto-join', () => {
  it('takes auto-join channels open to everyone; none for guests without autojoin_guests', () => {
    const cfg = {
      channels: [
        { name: '#ircforever', autojoin: true },
        { name: '#ircnow', autojoin: true },
        { name: '#opers', autojoin: true, restricted: true },
        { name: '#staff', autojoin: true, roles: ['Admin'] },
        { name: '#quiet' },
        { name: 'bad name', autojoin: true },
      ],
    };
    expect(networkAutojoinChannels(cfg, { guest: false })).toEqual(['#ircforever', '#ircnow']);
    expect(networkAutojoinChannels(cfg, { guest: true })).toEqual(['#ircforever', '#ircnow']);
    expect(networkAutojoinChannels({ ...cfg, autojoin_guests: false }, { guest: true })).toEqual([]);
    expect(networkAutojoinChannels({ ...cfg, autojoin_guests: false }, { guest: false })).toEqual(['#ircforever', '#ircnow']);
    expect(networkAutojoinChannels(null, { guest: false })).toEqual([]);
  });

  it('remembers what was handled per account / guest nick and server; a part stays parted', () => {
    const s = mem();
    const alice = autojoinWho({ userId: 'usr_a' });
    const guest = autojoinWho({ guestNick: 'ZestyKiwi' });
    expect(guest).toBe('guest:zestykiwi');
    const wanted = ['#IRCForever', '#ircnow'];
    expect(networkChannelsToJoin(wanted, networkAutojoined(server, alice, s), [])).toEqual(wanted);
    markNetworkAutojoined(server, alice, wanted, s);
    // Parted #ircnow (not in `have`): still not joined again.
    expect(networkChannelsToJoin(wanted, networkAutojoined(server, alice, s), ['#ircforever'])).toEqual([]);
    // A new channel in the config: once.
    expect(networkChannelsToJoin([...wanted, '#new'], networkAutojoined(server, alice, s), [])).toEqual(['#new']);
    // Someone else, or another server: their own record.
    expect(networkAutojoined(server, guest, s)).toEqual([]);
    expect(networkAutojoined({ hostname: 'irc.other.test', port: 6697 }, alice, s)).toEqual([]);
    // Without storage: nothing remembered, nothing thrown.
    expect(networkAutojoined(server, alice, null)).toEqual([]);
  });
});
