import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/preact';
import userEvent from '@testing-library/user-event';
import { DirectoryScreen } from './DirectoryScreen';
import { AuthProvider } from '../../modules/auth';
import type { AuthService } from '../../modules/auth';
import type { DirectoryService, Server, User } from '../../modules/directory';

function buildFakeAuth(): AuthService {
  return {
    signIn: vi.fn(),
    signUp: vi.fn(),
    signOut: vi.fn(async () => {}),
    getToken: vi.fn(async () => 'jwt'),
    getState: vi.fn(() => ({
      session: { access_token: 'jwt', user: { id: 'u1', email: 'a@b' } },
      loading: false,
      error: null,
    })),
    subscribe: vi.fn((fn: (s: unknown) => void) => {
      fn({ session: { access_token: 'jwt', user: { id: 'u1', email: 'a@b' } }, loading: false, error: null });
      return () => {};
    }),
    init: vi.fn(async () => {}),
    markFatal: vi.fn(),
  } as unknown as AuthService;
}

function fakeServer(name: string): Server {
  return {
    id: name, hostname: `irc.${name}`, port: 6697, tls: true, name,
    tags: [], languages: ['en'], is_nsfw: false, is_featured: false,
    verification_status: 'pending', health_status: 'unknown',
    registered_at: '2026-01-01',
  };
}

function buildDirectory(opts: {
  user?: User | null;
  servers?: Server[];
  listImpl?: DirectoryService['listServers'];
  setupImpl?: DirectoryService['setupMe'];
}): DirectoryService {
  return {
    getMe: vi.fn(async () => opts.user ?? null) as DirectoryService['getMe'],
    listServers: opts.listImpl ?? (vi.fn(async () => opts.servers ?? []) as DirectoryService['listServers']),
    setupMe: opts.setupImpl ?? (vi.fn(async (handle: string) => ({
      id: 'u1', handle, is_discoverable: true, encrypted_user_secret: '', created_at: '2026-01-01',
    })) as DirectoryService['setupMe']),
    getSavedSession: vi.fn(async () => null) as DirectoryService['getSavedSession'],
    putSavedSession: vi.fn(async () => undefined) as DirectoryService['putSavedSession'],
  } as unknown as DirectoryService;
}

function buildFakeIdentity() {
  return {
    isUnlocked: () => true,
    getState: () => ({ status: 'unlocked' as const }),
    subscribe: () => () => {},
    initializeForNewUser: async () => 'b64',
    unlock: async () => {},
    saslPasswordForServer: async () => 'pw',
    lock: () => {},
    getPendingEncrypted: () => 'pending-b64',
    getPendingRecovery: () => ({ recoveryBlob: 'recovery-b64', recoveryCode: 'abcd-ef5h' }),
    clearPendingEncrypted: () => {},
    // Keychain persistence surface (added 2026-05). Defaults are no-ops so
    // tests that don't care about persistence don't need to opt in.
    persist: async () => true,
    restoreFromStorage: async () => false,
    clearStorage: async () => {},
  } as unknown as import('../../modules/identity').IdentityService;
}

function renderWith(directory: DirectoryService) {
  return render(
    <AuthProvider service={buildFakeAuth()}>
      <DirectoryScreen directory={directory} engine={null} identity={buildFakeIdentity()} />
    </AuthProvider>
  );
}

describe('DirectoryScreen', () => {
  it('renders the list of servers', async () => {
    const directory = buildDirectory({
      user: { id: 'u1', handle: 'alice', is_discoverable: true, encrypted_user_secret: '', created_at: '2026-01-01' },
      servers: [fakeServer('Libera'), fakeServer('OFTC')],
    });
    renderWith(directory);

    expect(await screen.findByText('Libera')).toBeInTheDocument();
    expect(screen.getByText('OFTC')).toBeInTheDocument();
    // The address is a detail (in the server's details), not on the card.
    expect(screen.queryByText(/irc\.Libera/)).toBeNull();
  });

  it('a click on a card opens its details: description, channels, address', async () => {
    const directory = buildDirectory({
      user: { id: 'u1', handle: 'alice', is_discoverable: true, encrypted_user_secret: '', created_at: '2026-01-01' },
      servers: [{ ...fakeServer('Libera'), description: 'Free software chat', channels: ['#help', '#lobby'], autojoin_channels: ['#lobby'] }],
    });
    renderWith(directory);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Libera: details' }));
    const dialog = await screen.findByRole('dialog', { name: 'Libera' });
    expect(dialog).toHaveTextContent('Free software chat');
    // Default channels first.
    const rows = Array.from(dialog.querySelectorAll('.directory-details-channel')).map((r) => r.textContent);
    expect(rows[0]).toContain('#lobby');
    expect(rows[0]).toContain('Everyone starts here');
    expect(rows[1]).toContain('#help');
    expect(dialog).toHaveTextContent('irc.Libera:6697 (TLS)');
  });

  it('an empty search offers Clear search and Add a server by address', async () => {
    const listServers = vi.fn(async (q?: { q?: string }) => (q?.q ? [] : [fakeServer('Libera')])) as unknown as DirectoryService['listServers'];
    const directory = buildDirectory({
      user: { id: 'u1', handle: 'alice', is_discoverable: true, encrypted_user_secret: '', created_at: '2026-01-01' },
      listImpl: listServers,
    });
    renderWith(directory);
    await screen.findByText('Libera');
    const user = userEvent.setup();
    await user.type(screen.getByPlaceholderText('Search servers…'), 'zzz');
    const clear = await screen.findByRole('button', { name: 'Clear search' }, { timeout: 2000 });
    expect(screen.getByRole('button', { name: 'Add a server by address' })).toBeInTheDocument();
    await user.click(clear);
    expect(screen.getByPlaceholderText('Search servers…')).toHaveValue('');
    expect(await screen.findByText('Libera', {}, { timeout: 2000 })).toBeInTheDocument();
  });

  it('Add by address: host, port and name up front; TLS under More options moves the port', async () => {
    const directory = buildDirectory({
      user: { id: 'u1', handle: 'alice', is_discoverable: true, encrypted_user_secret: '', created_at: '2026-01-01' },
      servers: [],
    });
    renderWith(directory);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Add by address' }));
    const dialog = await screen.findByRole('dialog', { name: 'Add a server by address' });
    expect(dialog.querySelector('input[type="password"]')).toBeNull();
    const port = screen.getByDisplayValue('6697');
    await user.click(screen.getByRole('button', { name: /More options/ }));
    expect(dialog.querySelectorAll('input[type="password"]').length).toBe(3);
    await user.click(screen.getByText('Use TLS (recommended)'));
    expect(port).toHaveValue('6667');
    await user.click(screen.getByText('Use TLS (recommended)'));
    expect(port).toHaveValue('6697');
    // A port of its own stays put.
    await user.clear(port);
    await user.type(port, '7000');
    await user.click(screen.getByText('Use TLS (recommended)'));
    expect(port).toHaveValue('7000');
  });

  it('no Bouncer tab without a bouncer set up', async () => {
    const directory = buildDirectory({
      user: { id: 'u1', handle: 'alice', is_discoverable: true, encrypted_user_secret: '', created_at: '2026-01-01' },
      servers: [fakeServer('Libera')],
    });
    renderWith(directory);
    await screen.findByText('Libera');
    expect(screen.queryByRole('tab', { name: 'Bouncer' })).toBeNull();
  });

  it("shows the channels a listing puts new people in (autojoin_channels)", async () => {
    const directory = buildDirectory({
      user: { id: 'u1', handle: 'alice', is_discoverable: true, encrypted_user_secret: '', created_at: '2026-01-01' },
      servers: [{ ...fakeServer('Boson'), autojoin_channels: ['#lobby'] }, fakeServer('OFTC')],
    });
    renderWith(directory);
    expect(await screen.findByText('Joins #lobby')).toBeInTheDocument();
    // A listing without them (or from an older directory) says nothing.
    expect(document.querySelectorAll('.directory-card-joins')).toHaveLength(1);
  });

  it('shows empty state when there are no servers', async () => {
    const directory = buildDirectory({
      user: { id: 'u1', handle: 'alice', is_discoverable: true, encrypted_user_secret: '', created_at: '2026-01-01' },
      servers: [],
    });
    renderWith(directory);

    expect(await screen.findByText('No servers found.')).toBeInTheDocument();
  });

  it('shows SetupPrompt when /me returns null', async () => {
    const directory = buildDirectory({ user: null, servers: [] });
    renderWith(directory);

    expect(await screen.findByText('Finish setting up your account')).toBeInTheDocument();
  });

  it('SetupPrompt submits handle and dismisses', async () => {
    const setupMe = vi.fn(async (handle: string) => ({
      id: 'u1', handle, is_discoverable: true, encrypted_user_secret: '', created_at: '2026-01-01',
    }));
    const directory = buildDirectory({
      user: null,
      servers: [],
      setupImpl: setupMe as DirectoryService['setupMe'],
    });
    renderWith(directory);

    await screen.findByText('Finish setting up your account');
    const user = userEvent.setup();
    const handleInput = screen.getByPlaceholderText('handle');
    await user.type(handleInput, 'alice');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      // handle, password-wrap, recovery-wrap — recovery is forwarded so a new
      // account has a recovery path from creation.
      expect(setupMe).toHaveBeenCalledWith('alice', expect.any(String), 'recovery-b64');
    });
  });

  it('search box re-issues list with q param after debounce', async () => {
    const listServers = vi.fn(async () => [fakeServer('Libera')]) as unknown as DirectoryService['listServers'];
    const directory = buildDirectory({
      user: { id: 'u1', handle: 'alice', is_discoverable: true, encrypted_user_secret: '', created_at: '2026-01-01' },
      servers: [fakeServer('Libera')],
      listImpl: listServers,
    });
    renderWith(directory);

    await screen.findByText('Libera');
    const user = userEvent.setup();
    await user.type(screen.getByPlaceholderText('Search servers…'), 'foss');

    await waitFor(() => {
      const lastCall = (listServers as ReturnType<typeof vi.fn>).mock.calls.at(-1);
      expect(lastCall?.[0]).toEqual({ q: 'foss' });
    }, { timeout: 1000 });
  });

  it('one top bar: no engine pill or Sign out in the directory (Sign out is in User settings)', async () => {
    const directory = buildDirectory({
      user: { id: 'u1', handle: 'alice', is_discoverable: true, encrypted_user_secret: '', created_at: '2026-01-01' },
      servers: [],
    });
    renderWith(directory);
    await screen.findByText('No servers found.');
    expect(screen.queryByRole('button', { name: 'Sign out' })).toBeNull();
    expect(document.querySelector('.engine-pill')).toBeNull();
    expect(screen.queryByText(/boson dir/)).toBeNull();
  });
});
