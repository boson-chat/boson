import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/preact';
import userEvent from '@testing-library/user-event';
import { UserSettings, UpdateActions, platformLabel, resolveSection } from './UserSettings';
import pkg from '../../../../../package.json';
import { HttpError } from '../../shared/http/http.client';
import type { DirectoryService } from '../../modules/directory';
import type { AuthService } from '../../modules/auth';
import type { IdentityService } from '../../modules/identity';
import { clearGuestSession, saveGuestSession } from '../../modules/guest/guest';
import { setNetworkAccounts, type NetworkAccounts } from '../../modules/netauth/network-accounts';
import { SecureBouncerStore, setBouncerStore } from '../../modules/chat/bouncer.store';
import { InMemorySecureStorage } from '../../shared/secure-storage';
import { setHomeNetwork } from '../../modules/netauth/home-network';
import { isTelemetryEnabled } from '../../modules/telemetry/telemetry';

// UserSettings covers two distinct behaviours:
// 1. About panel surfaces the app version from package.json (regression
//    guard against the import path drifting after a file-move).
// 2. Identity panel for signed-in users shows an editable handle that
//    fetches the authoritative value from /me on open and persists via
//    PATCH /me + session user_metadata mirror.

function stubDirectory(overrides: Partial<DirectoryService> = {}): DirectoryService {
  return {
    getMe: vi.fn(async () => ({
      id: '1', handle: 'alice', is_discoverable: true,
      encrypted_user_secret: '', created_at: '2026-01-01',
    })),
    updateMe: vi.fn(async (p: { handle?: string }) => ({
      id: '1', handle: p.handle ?? 'alice', is_discoverable: true,
      encrypted_user_secret: '', created_at: '2026-01-01',
    })),
    updateSecretWraps: vi.fn(async () => ({
      id: '1', handle: 'alice', is_discoverable: true,
      encrypted_user_secret: '', created_at: '2026-01-01',
    })),
    ...overrides,
  } as unknown as DirectoryService;
}

function stubAuth(overrides: Partial<AuthService> = {}): AuthService {
  return {
    updateMetadata: vi.fn(async () => undefined),
    ...overrides,
  } as unknown as AuthService;
}

function stubIdentity(overrides: Partial<IdentityService> = {}): IdentityService {
  return {
    isUnlocked: vi.fn(() => true),
    enrollRecoveryCode: vi.fn(async () => ({ recoveryBlob: 'rec-b64', recoveryCode: 'abcd-ef5h' })),
    ...overrides,
  } as unknown as IdentityService;
}

function renderSettings(props: Partial<Parameters<typeof UserSettings>[0]> = {}) {
  return render(
    <UserSettings
      open
      onClose={() => {}}
      authedHandle="alice"
      authedEmail="alice@example.dev"
      onSignOut={() => {}}
      directory={stubDirectory()}
      identity={stubIdentity()}
      auth={stubAuth()}
      {...props}
    />,
  );
}

function handleInput(container: Element): HTMLInputElement {
  // Identity → account mode renders a single <input> (the Handle field).
  // Querying directly is simpler than fighting the Field component's
  // sibling-label DOM shape with getByLabelText. Exclude the avatar
  // control's hidden file input, which precedes the Handle field.
  const el = container.querySelector('input:not([type="file"])');
  if (!el) throw new Error('handle input not found');
  return el as HTMLInputElement;
}

beforeEach(() => {
  // Make sure we start each test in account mode (no guest session
  // bleeds in from an earlier test in the same vitest worker).
  clearGuestSession();
});

describe('UserSettings — About panel', () => {
  it('shows the app version, platform, and source link', async () => {
    renderSettings();

    const user = userEvent.setup();
    await user.click(screen.getByRole('tab', { name: /About/ }));

    expect(screen.getByText(`v${pkg.version}`)).toBeInTheDocument();
    const sourceLink = screen.getByRole('link', { name: /boson-chat\/boson/ });
    expect(sourceLink).toHaveAttribute('href', 'https://github.com/boson-chat/boson');
    const releaseLink = screen.getByRole('link', { name: new RegExp(`v${pkg.version} on GitHub`) });
    expect(releaseLink).toHaveAttribute(
      'href',
      `https://github.com/boson-chat/boson/releases/tag/v${pkg.version}`,
    );
  });

  it('keeps a pushed update state when the initial read lands after it', async () => {
    let resolveRead!: (s: { kind: string }) => void;
    let push!: (s: { kind: string; version?: string }) => void;
    const w = window as unknown as { bosonUpdater?: unknown };
    w.bosonUpdater = {
      getState: () => new Promise((r) => { resolveRead = r; }),
      onState: (fn: typeof push) => { push = fn; return () => {}; },
      checkNow: vi.fn(),
      applyDownloadedUpdate: vi.fn(),
    };
    try {
      renderSettings();
      await userEvent.setup().click(screen.getByRole('tab', { name: /About/ }));
      await waitFor(() => expect(push).toBeTypeOf('function'));
      push({ kind: 'checking' });
      await screen.findByText('Checking…');
      resolveRead({ kind: 'idle' });
      await new Promise((r) => setTimeout(r, 0));
      expect(screen.getByText('Checking…')).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Check for updates' })).toBeNull();
    } finally {
      delete w.bosonUpdater;
    }
  });
});

describe('UserSettings — Identity panel (account mode)', () => {
  it('prefills the handle input from authedHandle on first render', () => {
    const { container } = renderSettings({ authedHandle: 'alice' });
    expect(handleInput(container).value).toBe('alice');
  });

  it('replaces the prefill with the authoritative /me handle once loaded', async () => {
    const directory = stubDirectory({
      // Backend's view of truth differs from the stale session metadata
      // cache — the form must trust the backend.
      getMe: vi.fn(async () => ({
        id: '1', handle: 'real-alice', is_discoverable: true,
        encrypted_user_secret: '', created_at: '2026-01-01',
      })),
    } as unknown as Partial<DirectoryService>);
    const { container } = renderSettings({ authedHandle: 'stale-alice', directory });

    await waitFor(() => {
      expect(handleInput(container).value).toBe('real-alice');
    });
  });

  it('save button is disabled when the handle is unchanged', async () => {
    const { container } = renderSettings({ authedHandle: 'alice' });
    await waitFor(() => {
      expect(handleInput(container).value).toBe('alice');
    });
    const save = screen.getByRole('button', { name: /^Save$/ });
    expect(save).toBeDisabled();
  });

  it('PATCHes /me on save and mirrors the new handle into the session metadata', async () => {
    const directory = stubDirectory();
    const auth = stubAuth();
    const { container } = renderSettings({ authedHandle: 'alice', directory, auth });

    await waitFor(() => {
      expect(handleInput(container).value).toBe('alice');
    });

    const input = handleInput(container);
    await userEvent.setup().clear(input);
    await userEvent.setup().type(input, 'alice-new');
    fireEvent.click(screen.getByRole('button', { name: /^Save$/ }));

    await waitFor(() => {
      expect(directory.updateMe).toHaveBeenCalledWith({ handle: 'alice-new' });
    });
    expect(auth.updateMetadata).toHaveBeenCalledWith({ handle: 'alice-new' });
    expect(await screen.findByText('Saved')).toBeInTheDocument();
  });

  it('surfaces a 409 from PATCH /me as a handle-taken error', async () => {
    const directory = stubDirectory({
      updateMe: vi.fn(async () => { throw new HttpError(409, 'handle taken', null); }),
    } as unknown as Partial<DirectoryService>);
    const { container } = renderSettings({ authedHandle: 'alice', directory });
    await waitFor(() => {
      expect(handleInput(container).value).toBe('alice');
    });

    const input = handleInput(container);
    await userEvent.setup().clear(input);
    await userEvent.setup().type(input, 'taken');
    fireEvent.click(screen.getByRole('button', { name: /^Save$/ }));

    expect(await screen.findByText(/that handle is taken/i)).toBeInTheDocument();
  });

  it('surfaces a 400 from PATCH /me as a too-short error', async () => {
    const directory = stubDirectory({
      updateMe: vi.fn(async () => { throw new HttpError(400, 'handle must be at least 3 characters', { error: 'handle must be at least 3 characters' }); }),
    } as unknown as Partial<DirectoryService>);
    const { container } = renderSettings({ authedHandle: 'alice', directory });
    await waitFor(() => {
      expect(handleInput(container).value).toBe('alice');
    });
    const input = handleInput(container);
    await userEvent.setup().clear(input);
    await userEvent.setup().type(input, 'xy');
    fireEvent.click(screen.getByRole('button', { name: /^Save$/ }));

    expect(await screen.findByText(/at least 3 characters/i)).toBeInTheDocument();
  });

  it("shows the backend's reason for an invalid_handle 400 (A4)", async () => {
    const directory = stubDirectory({
      updateMe: vi.fn(async () => {
        throw new HttpError(400, 'handle must start with a letter or one of []\\`_^{|}', { error: 'handle must start with a letter or one of []\\`_^{|}', code: 'invalid_handle' });
      }),
    } as unknown as Partial<DirectoryService>);
    const { container } = renderSettings({ authedHandle: 'alice', directory });
    await waitFor(() => {
      expect(handleInput(container).value).toBe('alice');
    });
    const input = handleInput(container);
    await userEvent.setup().clear(input);
    await userEvent.setup().type(input, 'alicia');
    fireEvent.click(screen.getByRole('button', { name: /^Save$/ }));

    expect(await screen.findByText('Handle must start with a letter or one of []\\`_^{|}.')).toBeInTheDocument();
    expect(screen.queryByText(/at least 3 characters/i)).toBeNull();
  });

  it('falls back silently to authedHandle if /me throws', async () => {
    const directory = stubDirectory({
      getMe: vi.fn(async () => { throw new Error('boom'); }),
    } as unknown as Partial<DirectoryService>);
    const { container } = renderSettings({ authedHandle: 'alice-fallback', directory });
    // Input keeps the prefilled value; no error banner is shown for
    // the read failure (we still let the user save).
    expect(handleInput(container).value).toBe('alice-fallback');
    expect(screen.queryByText(/could not save/i)).not.toBeInTheDocument();
  });

  it('skips the /me fetch when the modal is closed', () => {
    const directory = stubDirectory();
    render(
      <UserSettings
        open={false}
        onClose={() => {}}
        authedHandle="alice"
        authedEmail="alice@example.dev"
        onSignOut={() => {}}
        directory={directory}
        identity={stubIdentity()}
        auth={stubAuth()}
      />,
    );
    expect(directory.getMe).not.toHaveBeenCalled();
  });
});

describe('UserSettings — Account recovery code', () => {
  it('offers "Set up recovery code" when none exists and reveals a code on enroll', async () => {
    const directory = stubDirectory(); // getMe returns no recovery wrap
    const identity = stubIdentity();
    renderSettings({ directory, identity });

    const user = userEvent.setup();
    await user.click(screen.getByRole('tab', { name: /Account/ }));

    const enrollBtn = await screen.findByRole('button', { name: /Set up recovery code/i });
    await user.click(enrollBtn);

    await waitFor(() => {
      expect(screen.getByText('Your recovery code')).toBeInTheDocument();
    });
    expect(screen.getByLabelText('recovery code')).toHaveTextContent('abcd-ef5h');
    expect(identity.enrollRecoveryCode).toHaveBeenCalled();
    expect(directory.updateSecretWraps).toHaveBeenCalledWith({ recoveryBlob: 'rec-b64' });
  });

  it('shows "Regenerate" when a recovery wrap already exists', async () => {
    const directory = stubDirectory({
      getMe: vi.fn(async () => ({
        id: '1', handle: 'alice', is_discoverable: true,
        encrypted_user_secret: '', encrypted_user_secret_recovery: 'existing', created_at: '2026-01-01',
      })),
    } as Partial<DirectoryService>);
    renderSettings({ directory });

    const user = userEvent.setup();
    await user.click(screen.getByRole('tab', { name: /Account/ }));

    expect(await screen.findByRole('button', { name: /Regenerate recovery code/i })).toBeInTheDocument();
  });

  it('refuses to enroll when the identity is locked', async () => {
    const identity = stubIdentity({ isUnlocked: vi.fn(() => false) } as Partial<IdentityService>);
    renderSettings({ identity });

    const user = userEvent.setup();
    await user.click(screen.getByRole('tab', { name: /Account/ }));
    await user.click(await screen.findByRole('button', { name: /Set up recovery code/i }));

    expect(screen.getByText(/locked/i)).toBeInTheDocument();
    expect(identity.enrollRecoveryCode).not.toHaveBeenCalled();
  });
});

describe('UserSettings — Bouncer panel', () => {
  async function freshStore() {
    const s = new SecureBouncerStore(new InMemorySecureStorage(), { probeIntervalMs: 1, probeTimeoutMs: 5 });
    await s.whenHydrated();
    setBouncerStore(s);
    return s;
  }

  it('saves the global bouncer profile to the store', async () => {
    const store = await freshStore();
    renderSettings();
    fireEvent.click(screen.getByRole('tab', { name: /Bouncer/ }));

    fireEvent.click(screen.getByLabelText('Use a bouncer'));
    await userEvent.setup().type(screen.getByPlaceholderText('znc.example.com'), 'znc.host');
    await userEvent.setup().type(screen.getByPlaceholderText('me'), 'james');
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      const p = store.get();
      expect(p?.enabled).toBe(true);
      expect(p?.host).toBe('znc.host');
      expect(p?.username).toBe('james');
    });
  });

  it('warns when self-signed certificates are allowed', async () => {
    await freshStore();
    renderSettings();
    fireEvent.click(screen.getByRole('tab', { name: /Bouncer/ }));
    fireEvent.click(screen.getByLabelText('Use a bouncer'));
    expect(screen.queryByText(/Skips TLS certificate verification/)).toBeNull();
    fireEvent.click(screen.getByLabelText('Allow self-signed certificate'));
    expect(screen.getByText(/Skips TLS certificate verification/)).toBeInTheDocument();
  });
});

describe('UpdateActions', () => {
  const noop = () => {};

  it('offers a check when idle, and says when up to date', () => {
    const onCheck = vi.fn();
    const { rerender } = render(<UpdateActions state={{ kind: 'idle' }} onCheck={onCheck} onApply={noop} />);
    fireEvent.click(screen.getByRole('button', { name: 'Check for updates' }));
    expect(onCheck).toHaveBeenCalledOnce();
    rerender(<UpdateActions state={{ kind: 'up-to-date', checkedAt: 1 }} onCheck={onCheck} onApply={noop} />);
    expect(screen.getByText('Up to date.')).toBeTruthy();
  });

  it('shows checking with no buttons', () => {
    render(<UpdateActions state={{ kind: 'checking' }} onCheck={noop} onApply={noop} />);
    expect(screen.getByText('Checking…')).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('offers the release page when this copy can\'t install it itself', () => {
    const onApply = vi.fn();
    const onDownload = vi.fn();
    render(<UpdateActions state={{ kind: 'available', version: '0.37.0', manual: true }} onCheck={noop} onDownload={onDownload} onApply={onApply} />);
    fireEvent.click(screen.getByRole('button', { name: 'Download v0.37.0' }));
    expect(onApply).toHaveBeenCalledOnce();
    expect(onDownload).not.toHaveBeenCalled();
  });

  it('downloads an available update only when clicked', () => {
    const onDownload = vi.fn();
    const onApply = vi.fn();
    render(<UpdateActions state={{ kind: 'available', version: '0.37.0' }} onCheck={noop} onDownload={onDownload} onApply={onApply} />);
    expect(screen.getByText('v0.37.0 is available.')).toBeTruthy();
    expect(onDownload).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Update to v0.37.0' }));
    expect(onDownload).toHaveBeenCalledOnce();
    expect(onApply).not.toHaveBeenCalled();
  });

  it('shows download progress as a whole percentage', () => {
    render(<UpdateActions state={{ kind: 'downloading', version: '0.37.0', percent: 42.7, bytesPerSecond: 1 }} onCheck={noop} onApply={noop} />);
    expect(screen.getByRole('status').textContent).toBe('Downloading v0.37.0 · 42%');
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('offers Restart to update when ready', () => {
    const onApply = vi.fn();
    render(<UpdateActions state={{ kind: 'ready', version: '0.37.0' }} platform="darwin" onCheck={noop} onApply={onApply} />);
    expect(screen.getByText('v0.37.0 is ready.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Restart to update' }));
    expect(onApply).toHaveBeenCalledOnce();
  });

  it('offers Install on Android (the system installer takes over)', () => {
    render(<UpdateActions state={{ kind: 'ready', version: '0.37.0' }} platform="android" onCheck={noop} onApply={noop} />);
    expect(screen.getByRole('button', { name: 'Install v0.37.0' })).toBeTruthy();
  });

  it('shows errors, summarised, with a way to check again', () => {
    render(<UpdateActions state={{ kind: 'error', message: 'v0.37.0 failed signature verification, so it won\'t be installed.' }} onCheck={noop} onApply={noop} />);
    expect(screen.getByRole('alert').textContent).toBe('v0.37.0 failed signature verification, so it won\'t be installed.');
    expect(screen.getByRole('button', { name: 'Check for updates' })).toBeTruthy();
  });
});

describe('UserSettings — About: in-app updates', () => {
  type Push = (s: Record<string, unknown>) => void;
  function stubUpdater(extra: Record<string, unknown> = {}) {
    let push!: Push;
    const bridge = {
      getState: vi.fn(() => Promise.resolve({ kind: 'idle' })),
      onState: (fn: Push) => { push = fn; return () => {}; },
      checkNow: vi.fn(() => Promise.resolve()),
      download: vi.fn(() => Promise.resolve()),
      applyDownloadedUpdate: vi.fn(() => Promise.resolve()),
      getAutoInstall: vi.fn(() => Promise.resolve(false)),
      setAutoInstall: vi.fn(() => Promise.resolve()),
      ...extra,
    };
    (window as unknown as { bosonUpdater?: unknown }).bosonUpdater = bridge;
    return { bridge, push: (s: Record<string, unknown>) => push(s) };
  }
  afterEach(() => {
    delete (window as unknown as { bosonUpdater?: unknown }).bosonUpdater;
    delete (window as unknown as { bosonPlatform?: string }).bosonPlatform;
  });

  async function openAbout() {
    renderSettings();
    await userEvent.setup().click(screen.getByRole('tab', { name: /About/ }));
  }

  it('several releases behind: the notes are headed "What\'s new since" the installed version', async () => {
    const { bridge, push } = stubUpdater();
    await openAbout();
    await waitFor(() => expect(bridge.getState).toHaveBeenCalled());
    const notes = 'v9.1.0\nBug Fixes\n• b\n\nv9.0.0\nFeatures\n• a';
    push({ kind: 'ready', version: '9.1.0', notes, notesSince: '8.0.0' });
    expect(await screen.findByText("What's new since v8.0.0")).toBeTruthy();
    expect(document.querySelector('.user-settings-update-notes')?.textContent).toBe(notes);
  });

  it('walks available → downloading → ready, with the release notes', async () => {
    const { bridge, push } = stubUpdater();
    await openAbout();
    await waitFor(() => expect(bridge.getState).toHaveBeenCalled());
    const notes = 'Features\n• desktop: in-app updates';
    push({ kind: 'available', version: '9.0.0', notes });
    fireEvent.click(await screen.findByRole('button', { name: 'Update to v9.0.0' }));
    expect(bridge.download).toHaveBeenCalledOnce();
    expect(screen.getByText("What's new in v9.0.0")).toBeTruthy();
    expect(document.querySelector('.user-settings-update-notes')?.textContent).toBe(notes);
    push({ kind: 'downloading', version: '9.0.0', percent: 30, bytesPerSecond: 5, notes });
    await screen.findByText('Downloading v9.0.0 · 30%');
    push({ kind: 'ready', version: '9.0.0', notes });
    fireEvent.click(await screen.findByRole('button', { name: 'Restart to update' }));
    expect(bridge.applyDownloadedUpdate).toHaveBeenCalledOnce();
  });

  it('explains why an update must be installed by hand', async () => {
    const { bridge, push } = stubUpdater();
    await openAbout();
    await waitFor(() => expect(bridge.getState).toHaveBeenCalled());
    const message = 'macOS is running Boson from a temporary read-only copy, so it can\'t update itself. Quit Boson, move it to your Applications folder, and open it from there.';
    push({ kind: 'available', version: '9.0.0', manual: true, message });
    expect((await screen.findByRole('note')).textContent).toBe(message);
    expect(screen.getByRole('button', { name: 'Download v9.0.0' })).toBeTruthy();
  });

  it('has an opt-in, off by default, for automatic installs', async () => {
    const { bridge } = stubUpdater();
    await openAbout();
    const toggle = await screen.findByLabelText('Install updates automatically');
    await waitFor(() => expect(bridge.getAutoInstall).toHaveBeenCalled());
    expect((toggle as HTMLInputElement).checked).toBe(false);
    fireEvent.click(toggle);
    expect(bridge.setAutoInstall).toHaveBeenCalledWith(true);
  });

  it('has no automatic installs on Android', async () => {
    (window as unknown as { bosonPlatform?: string }).bosonPlatform = 'android';
    stubUpdater();
    await openAbout();
    await screen.findByRole('button', { name: 'Check for updates' });
    expect(screen.queryByLabelText('Install updates automatically')).toBeNull();
  });

  it('shows no updater at all without the bridge (a browser, iOS)', async () => {
    await openAbout();
    expect(screen.queryByRole('button', { name: 'Check for updates' })).toBeNull();
    expect(screen.queryByLabelText('Install updates automatically')).toBeNull();
  });
});

describe('UserSettings — before signing in', () => {
  it('shows only Privacy, Appearance and About, not the account sections', () => {
    renderSettings({ signedOut: true, authedHandle: null, authedEmail: null });
    const tabs = screen.getAllByRole('tab').map((t) => t.textContent ?? '');
    expect(tabs.some((t) => t.startsWith('Privacy'))).toBe(true);
    expect(tabs.some((t) => t.startsWith('Appearance'))).toBe(true);
    expect(tabs.some((t) => t.startsWith('About'))).toBe(true);
    expect(tabs.some((t) => /^(Profile|Account|Bouncer)/.test(t))).toBe(false);
    expect(screen.queryByText('How you sign in to your Boson account.')).toBeNull();
    // Two entries need no group headings.
    expect(document.querySelector('.settings-menu-heading')).toBeNull();
  });
});

describe('UserSettings — Profile wording', () => {
  it('says what the handle is in plain words', () => {
    renderSettings({ authedHandle: 'alice' });
    expect(screen.getByText('How people find you on Boson, and your name in chat.')).toBeInTheDocument();
    expect(screen.queryByText(/sanitisation/)).toBeNull();
    expect(screen.queryByText(/next connect/)).toBeNull();
  });
});

describe('UserSettings — the menu', () => {
  const tabNames = (): string[] => screen.getAllByRole('tab').map((t) => t.textContent ?? '');
  const selected = (): string => screen.getAllByRole('tab').find((t) => t.getAttribute('aria-selected') === 'true')?.textContent ?? '';

  it('groups the sections under You, App and Connections, with About last', () => {
    renderSettings();
    const headings = [...document.querySelectorAll('.settings-menu-heading')].map((h) => h.textContent);
    expect(headings).toEqual(['You', 'App', 'Connections']);
    // In the order the groups read, top to bottom.
    const nav = document.querySelector('.user-settings-menu')!;
    const order = [...nav.children].map((el) => el.textContent || '—');
    expect(order).toEqual([
      'You', 'Profile', 'Account & security', 'Privacy',
      'App', 'Appearance', 'Notifications', 'Chat & media',
      'Connections', 'Directories', 'Bouncer',
      '—', 'About',
    ]);
    // It opens on Profile.
    expect(selected()).toBe('Profile');
  });

  it("has no Network accounts where they aren't supported", () => {
    renderSettings();
    expect(tabNames()).not.toContain('Network accounts');
  });

  it('lists Network accounts when the app supports them', () => {
    const fake = {
      getSnapshot: () => ({ known: [], sessions: {} }),
      subscribe: () => () => {},
      dispose: () => {},
    } as unknown as NetworkAccounts;
    setNetworkAccounts(fake);
    try {
      renderSettings({ initialSection: 'networks' });
      expect(selected()).toBe('Network accounts');
      expect(screen.getByText(/No network accounts yet/)).toBeInTheDocument();
    } finally {
      setNetworkAccounts(null);
    }
  });

  it.each([
    ['identity', 'Profile'],
    ['profile', 'Profile'],
    ['content', 'Chat & media'],
    ['chat', 'Chat & media'],
    ['privacy', 'Privacy'],
    ['notifications', 'Notifications'],
    ['account', 'Account & security'],
    ['about', 'About'],
  ])('opens at %s (old ids too): %s', (id, tab) => {
    renderSettings({ initialSection: id });
    expect(selected()).toBe(tab);
  });

  it('ignores an unknown section, and voice where there is no voice', () => {
    expect(resolveSection('nope')).toBeNull();
    renderSettings({ initialSection: 'voice' });
    expect(selected()).toBe('Profile');
    expect(tabNames()).not.toContain('Voice');
  });

  it('as a guest: Profile is the nick, Account offers an account, Privacy says calls need one', async () => {
    saveGuestSession({ nick: 'wren' });
    renderSettings({ authedHandle: null, authedEmail: null });
    expect(tabNames()).toContain('Account');
    expect(tabNames()).not.toContain('Account & security');
    expect(screen.getByDisplayValue('wren')).toBeInTheDocument();
    expect(screen.getByText('Guest, no account')).toBeInTheDocument();
    const user = userEvent.setup();
    await user.click(screen.getByRole('tab', { name: 'Account' }));
    expect(screen.getByRole('button', { name: 'Switch to an account' })).toBeInTheDocument();
    await user.click(screen.getByRole('tab', { name: 'Privacy' }));
    expect(screen.getByText(/Sign in to a Boson account to choose who can call you/)).toBeInTheDocument();
    // Remembered hosts are this device's, so they're here for guests too.
    expect(screen.getByRole('checkbox', { name: 'Remember hosts' })).toBeInTheDocument();
  });
});

describe('UserSettings — a self-hosted web client', () => {
  it("as a guest: Account names the install's own account, not boson.chat's", async () => {
    setHomeNetwork({ domain: 'boson.ircforever.org', name: 'boson.ircforever.org', selfHosted: true });
    try {
      saveGuestSession({ nick: 'wren' });
      renderSettings({ authedHandle: null, authedEmail: null });
      await userEvent.setup().click(screen.getByRole('tab', { name: 'Account' }));
      expect(screen.getByText(/You're using Boson without a boson\.ircforever\.org account/)).toBeInTheDocument();
      expect(screen.queryByText(/boson\.chat account/)).toBeNull();
      expect(screen.getByRole('button', { name: 'Switch to an account' })).toBeInTheDocument();
    } finally {
      setHomeNetwork(null);
    }
  });
});

describe('UserSettings — Account & security', () => {
  it('puts email, the recovery code, and sign out in one section', async () => {
    const onSignOut = vi.fn();
    const onClose = vi.fn();
    renderSettings({ initialSection: 'account', onSignOut, onClose });
    expect(screen.getByRole('heading', { name: 'Account & security' })).toBeInTheDocument();
    expect(screen.getByText('alice@example.dev')).toBeInTheDocument();
    // The recovery code is a row with a secondary button, not a big CTA.
    const setUp = await screen.findByRole('button', { name: 'Set up recovery code' });
    expect(setUp.className).not.toMatch(/primary/);
    expect(screen.getByText('Not set up')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    expect(onSignOut).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledOnce();
  });
});

describe('UserSettings — Chat & media', () => {
  beforeEach(() => localStorage.removeItem('boson:embeds:v1'));

  it('link previews are switch rows; the per-kind switches sit under the master and turn off with it', () => {
    renderSettings({ initialSection: 'content' });
    const master = screen.getByRole('checkbox', { name: 'Show link previews' });
    const kinds = ['Load automatically', 'Images', 'Videos', 'YouTube', 'Spotify', 'Website cards'];
    for (const k of kinds) {
      const box = screen.getByRole('checkbox', { name: k });
      expect(box).toBeEnabled();
      expect(box.closest('.user-settings-nested')).not.toBeNull();
    }
    fireEvent.click(master);
    for (const k of kinds) expect(screen.getByRole('checkbox', { name: k })).toBeDisabled();
    expect(document.querySelector('.user-settings-nested-off')).not.toBeNull();
    expect(JSON.parse(localStorage.getItem('boson:embeds:v1') ?? '{}')).toMatchObject({ enabled: false });
    // Click-to-load is "Load automatically" off.
    fireEvent.click(master);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Load automatically' }));
    expect(JSON.parse(localStorage.getItem('boson:embeds:v1') ?? '{}')).toMatchObject({ loadMode: 'click' });
  });

  it('no longer holds the remembered-hosts switches (they are under Privacy)', () => {
    renderSettings({ initialSection: 'chat' });
    expect(screen.queryByRole('checkbox', { name: 'Remember hosts' })).toBeNull();
  });
});

describe('UserSettings — Privacy', () => {
  it('holds remembered hosts; showing them in join/part lines needs remembering on', () => {
    renderSettings({ initialSection: 'privacy' });
    const remember = screen.getByRole('checkbox', { name: 'Remember hosts' });
    if (!(remember as HTMLInputElement).checked) fireEvent.click(remember);
    expect(screen.getByRole('checkbox', { name: 'Show hosts in join/part lines' })).toBeEnabled();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Remember hosts' }));
    expect(screen.getByRole('checkbox', { name: 'Show hosts in join/part lines' })).toBeDisabled();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Remember hosts' }));
    expect(screen.getByRole('button', { name: 'Clear remembered hosts' })).toBeInTheDocument();
  });
});

describe('UserSettings — Privacy: usage & health stats', () => {
  beforeEach(() => { localStorage.removeItem('boson:telemetry:v1'); });

  it('is on by default, says why, links the details, and the switch turns it off and on', () => {
    renderSettings({ initialSection: 'privacy' });
    const sw = screen.getByRole('checkbox', { name: 'Usage & health stats' });
    expect(sw).toBeChecked();
    expect(screen.getByText(/We collect a small amount of anonymous usage and health data to make Boson better/)).toBeInTheDocument();
    expect(screen.getByText(/No names, emails, messages, server names or IP addresses, ever\./)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /What’s sent/ })).toHaveAttribute('href', 'https://boson.chat/telemetry');
    fireEvent.click(sw);
    expect(sw).not.toBeChecked();
    expect(isTelemetryEnabled()).toBe(false);
    fireEvent.click(sw);
    expect(isTelemetryEnabled()).toBe(true);
  });

  it('is there before signing in too', () => {
    renderSettings({ signedOut: true, authedHandle: null, authedEmail: null, initialSection: 'privacy' });
    expect(screen.getByRole('checkbox', { name: 'Usage & health stats' })).toBeInTheDocument();
  });
});

describe('UserSettings — Bouncer: the connection details follow the switch', () => {
  it('shows host, port and TLS only while "Use a bouncer" is on', async () => {
    const s = new SecureBouncerStore(new InMemorySecureStorage(), { probeIntervalMs: 1, probeTimeoutMs: 5 });
    await s.whenHydrated();
    setBouncerStore(s);
    renderSettings({ initialSection: 'bouncer' });
    expect(screen.queryByPlaceholderText('znc.example.com')).toBeNull();
    expect(screen.queryByRole('checkbox', { name: 'Use TLS' })).toBeNull();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Use a bouncer' }));
    expect(screen.getByPlaceholderText('znc.example.com')).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'Use TLS' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'Flood control' })).toBeChecked();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Use a bouncer' }));
    expect(screen.queryByPlaceholderText('znc.example.com')).toBeNull();
  });
});

describe('platformLabel', () => {
  it.each([
    ['darwin', 'macOS'], ['MacIntel', 'macOS'], ['win32', 'Windows'], ['Win32', 'Windows'],
    ['linux', 'Linux'], ['Linux x86_64', 'Linux'], ['ios', 'iOS'], ['iPhone', 'iOS'],
    ['android', 'Android'], ['Linux armv8l; Android', 'Android'], ['', 'Unknown'],
  ])('%s: %s', (raw, label) => {
    expect(platformLabel(raw)).toBe(label);
  });

  it('About shows the friendly name, not the raw platform', () => {
    (window as unknown as { bosonPlatform?: string }).bosonPlatform = 'darwin';
    try {
      renderSettings({ initialSection: 'about' });
      expect(screen.getByText('macOS')).toBeInTheDocument();
    } finally {
      delete (window as unknown as { bosonPlatform?: string }).bosonPlatform;
    }
  });
});
