import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/preact';
import userEvent from '@testing-library/user-event';
import { UserSettings } from './UserSettings';
import pkg from '../../../../../package.json';
import { HttpError } from '../../shared/http/http.client';
import type { DirectoryService } from '../../modules/directory';
import type { AuthService } from '../../modules/auth';
import { clearGuestSession } from '../../modules/guest/guest';

// UserSettings covers two distinct behaviours:
// 1. About panel surfaces the app version from package.json (regression
//    guard against the import path drifting after a file-move).
// 2. Identity panel for signed-in users shows an editable handle that
//    fetches the authoritative value from /me on open and persists via
//    PATCH /me + Supabase user_metadata mirror.

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
    ...overrides,
  } as unknown as DirectoryService;
}

function stubAuth(overrides: Partial<AuthService> = {}): AuthService {
  return {
    updateMetadata: vi.fn(async () => undefined),
    ...overrides,
  } as unknown as AuthService;
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
      auth={stubAuth()}
      {...props}
    />,
  );
}

function handleInput(container: Element): HTMLInputElement {
  // Identity → account mode renders a single <input> (the Handle field).
  // Querying directly is simpler than fighting the Field component's
  // sibling-label DOM shape with getByLabelText.
  const el = container.querySelector('input');
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
});

describe('UserSettings — Identity panel (account mode)', () => {
  it('prefills the handle input from authedHandle on first render', () => {
    const { container } = renderSettings({ authedHandle: 'alice' });
    expect(handleInput(container).value).toBe('alice');
  });

  it('replaces the prefill with the authoritative /me handle once loaded', async () => {
    const directory = stubDirectory({
      // Backend's view of truth differs from the stale Supabase metadata
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

  it('PATCHes /me on save and mirrors the new handle into Supabase metadata', async () => {
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
      updateMe: vi.fn(async () => { throw new HttpError(400, 'too short', null); }),
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
        auth={stubAuth()}
      />,
    );
    expect(directory.getMe).not.toHaveBeenCalled();
  });
});
