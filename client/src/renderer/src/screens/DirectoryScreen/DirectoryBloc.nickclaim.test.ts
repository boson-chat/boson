import { describe, it, expect, vi } from 'vitest';
import { DirectoryBloc } from './DirectoryBloc';
import type { DirectoryService } from '../../modules/directory';
import type { AuthService } from '../../modules/auth';
import type { IdentityService } from '../../modules/identity';

// The nick-claim capability (GET /config): DirectoryBloc loads it at start
// and exposes it as state.nickClaimEnabled, which DirectoryScreen turns
// into ServerSettings' nickClaimDisabled.

function dir(getPublicConfig?: DirectoryService['getPublicConfig']): DirectoryService {
  return {
    getMe: vi.fn(async () => ({ id: 'u1', handle: 'alice', is_discoverable: true, encrypted_user_secret: '', created_at: '2026-01-01' })),
    listServers: vi.fn(async () => []),
    getSavedSession: vi.fn(async () => null),
    putSavedSession: vi.fn(async () => undefined),
    ...(getPublicConfig ? { getPublicConfig } : {}),
  } as unknown as DirectoryService;
}

function bloc(directory: DirectoryService, guestNick?: string): DirectoryBloc {
  return new DirectoryBloc({
    auth: { getState: () => ({ session: null }), subscribe: () => () => {} } as unknown as AuthService,
    directory,
    identity: { getState: () => ({ unlocked: false }), subscribe: () => () => {} } as unknown as IdentityService,
    engine: null,
    ...(guestNick ? { guestNick } : {}),
  });
}

const settle = () => new Promise((r) => setTimeout(r, 0));

describe('DirectoryBloc — nick-claim capability', () => {
  it('reads nick_claim from GET /config', async () => {
    const getPublicConfig = vi.fn(async () => ({ nick_claim: false }));
    const b = bloc(dir(getPublicConfig));
    expect(b.getState().nickClaimEnabled).toBeNull();
    await settle();
    expect(getPublicConfig).toHaveBeenCalled();
    expect(b.getState().nickClaimEnabled).toBe(false);

    // The admin turned it back on: the next refresh picks it up.
    getPublicConfig.mockResolvedValueOnce({ nick_claim: true });
    await b.refreshPublicConfig();
    expect(b.getState().nickClaimEnabled).toBe(true);
    b.dispose();
  });

  it('keeps the last known value when /config fails', async () => {
    const getPublicConfig = vi.fn(async () => ({ nick_claim: true }));
    const b = bloc(dir(getPublicConfig));
    await settle();
    expect(b.getState().nickClaimEnabled).toBe(true);
    getPublicConfig.mockRejectedValueOnce(new Error('offline'));
    await b.refreshPublicConfig();
    expect(b.getState().nickClaimEnabled).toBe(true);
    b.dispose();
  });

  it('guests never ask (no Boson account, no claims)', async () => {
    const getPublicConfig = vi.fn(async () => ({ nick_claim: true }));
    const b = bloc(dir(getPublicConfig), 'guest1');
    await settle();
    expect(getPublicConfig).not.toHaveBeenCalled();
    expect(b.getState().nickClaimEnabled).toBeNull();
    b.dispose();
  });
});
