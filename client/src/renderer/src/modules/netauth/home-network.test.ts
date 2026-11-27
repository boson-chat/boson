import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BOSON_CHAT_HOME, getHomeNetwork, joinHomeOnce, nameFromAuthConfig, onHomeNetworkChange, setHomeNetwork, updateHomeNetwork,
  type HomeNetwork,
} from './home-network';

function memStore(): Pick<Storage, 'getItem' | 'setItem'> & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => { data.set(k, v); } };
}

const SELF: HomeNetwork = {
  domain: 'boson.ircforever.org', name: 'boson.ircforever.org', selfHosted: true,
  irc: { host: 'irc.boson.ircforever.org', port: 6697, tls: true },
};

afterEach(() => setHomeNetwork(null));

describe('home network', () => {
  it('is boson.chat unless a web client says otherwise', () => {
    expect(getHomeNetwork()).toBe(BOSON_CHAT_HOME);
    expect(getHomeNetwork()).toEqual({ domain: 'boson.chat', name: 'boson.chat', selfHosted: false });
  });

  it('takes the name and IRC server found later, and tells listeners', () => {
    const seen: HomeNetwork[] = [];
    const off = onHomeNetworkChange((h) => seen.push(h));
    setHomeNetwork({ domain: 'boson.ircforever.org', name: 'boson.ircforever.org', selfHosted: true });
    updateHomeNetwork({ name: '  IRC Forever ' });
    updateHomeNetwork({ irc: SELF.irc });
    updateHomeNetwork({ name: '' }); // nothing new
    off();
    expect(seen.map((h) => h.name)).toEqual(['boson.ircforever.org', 'IRC Forever', 'IRC Forever']);
    expect(getHomeNetwork()).toEqual({ ...SELF, name: 'IRC Forever' });
  });

  it("never renames boson.chat or gives it an IRC server", () => {
    updateHomeNetwork({ name: 'Other', irc: SELF.irc });
    expect(getHomeNetwork()).toBe(BOSON_CHAT_HOME);
  });

  it('reads the name from the auth service config', () => {
    expect(nameFromAuthConfig({ site_name: ' IRC Forever ' })).toBe('IRC Forever');
    expect(nameFromAuthConfig({ network_name: 'Net' })).toBe('Net');
    expect(nameFromAuthConfig({})).toBe('');
    expect(nameFromAuthConfig(null)).toBe('');
  });
});

describe('joinHomeOnce', () => {
  it("joins a self-hosted network's own IRC server once per device", () => {
    const store = memStore();
    const join = vi.fn();
    expect(joinHomeOnce(SELF, join, store)).toBe(true);
    expect(join).toHaveBeenCalledWith({ host: 'irc.boson.ircforever.org', port: 6697, tls: true, name: 'boson.ircforever.org' });
    expect(joinHomeOnce(SELF, join, store)).toBe(false);
    expect(join).toHaveBeenCalledTimes(1);
  });

  it('joins again for a different IRC host', () => {
    const store = memStore();
    const join = vi.fn();
    joinHomeOnce(SELF, join, store);
    joinHomeOnce({ ...SELF, irc: { host: 'irc2.boson.ircforever.org', port: 6697, tls: true } }, join, store);
    expect(join).toHaveBeenCalledTimes(2);
  });

  it('does nothing for boson.chat or before the IRC server is known', () => {
    const join = vi.fn();
    expect(joinHomeOnce(BOSON_CHAT_HOME, join, memStore())).toBe(false);
    expect(joinHomeOnce({ ...SELF, irc: undefined }, join, memStore())).toBe(false);
    expect(join).not.toHaveBeenCalled();
  });

  it('survives an unreadable record and no storage', () => {
    const store = memStore();
    store.data.set('boson:home-joined:v1', '{oops');
    const join = vi.fn();
    expect(joinHomeOnce(SELF, join, store)).toBe(true);
    expect(joinHomeOnce(SELF, join, null)).toBe(true);
  });
});
