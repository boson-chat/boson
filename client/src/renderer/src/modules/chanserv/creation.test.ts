import { describe, expect, it, vi } from 'vitest';
import { CHANREG_PERMISSION, channelCreationFor, permissionsFor, resetCreationCache } from './creation';
import type { AuthService, Session } from '../auth';

const LOBBY = { name: '#lobby', topic: 'Welcome', autojoin: true };

describe('channel creation policy', () => {
  it('unknown without a config, or from a server that predates the setting', () => {
    expect(channelCreationFor(null, { signedIn: true, permissions: [] })).toBeNull();
    expect(channelCreationFor({ registration: 'open' }, { signedIn: true, permissions: [] })).toBeNull();
  });

  it('"registered": anyone may create; network channels still listed', () => {
    expect(channelCreationFor({ channel_creation: 'registered', channels: [LOBBY] }, { signedIn: false, permissions: null }))
      .toEqual({ restricted: false, channels: [LOBBY] });
  });

  it('"admins": guests and members without irc.chanreg are restricted', () => {
    const cfg = { channel_creation: 'admins', channels: [LOBBY, { name: 'nope' } as never, { name: '#help' }] };
    const guest = channelCreationFor(cfg, { signedIn: false, permissions: null });
    expect(guest).toEqual({ restricted: true, channels: [LOBBY, { name: '#help', autojoin: false }] });
    expect(channelCreationFor(cfg, { signedIn: true, permissions: ['channel.create'] })?.restricted).toBe(true);
    expect(channelCreationFor(cfg, { signedIn: true, permissions: null })?.restricted).toBe(true);
  });

  it('"admins": roles with irc.chanreg, and IRC operators, may create', () => {
    const cfg = { channel_creation: 'admins' };
    expect(channelCreationFor(cfg, { signedIn: true, permissions: [CHANREG_PERMISSION] })?.restricted).toBe(false);
    // A permission list without a session doesn't count.
    expect(channelCreationFor(cfg, { signedIn: false, permissions: [CHANREG_PERMISSION] })?.restricted).toBe(true);
    expect(channelCreationFor(cfg, { signedIn: false, permissions: null, oper: true })?.restricted).toBe(false);
  });

  it('asks GET /v1/me once per session, and again after a failure', async () => {
    resetCreationCache();
    const me = vi.fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue({ roles: [{ name: 'Admin' }], permissions: [CHANREG_PERMISSION] });
    const svc = { me } as unknown as AuthService;
    const session = { session_id: 's1', user: { id: 'u1' } } as Session;
    expect(await permissionsFor(svc, 'https://auth.example', session)).toBeNull();
    expect(await permissionsFor(svc, 'https://auth.example', session)).toEqual([CHANREG_PERMISSION]);
    expect(await permissionsFor(svc, 'https://auth.example', session)).toEqual([CHANREG_PERMISSION]);
    expect(me).toHaveBeenCalledTimes(2);
  });
});
