import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/preact';
import { UserSettings } from './UserSettings';
import type { DirectoryService } from '../../modules/directory';
import type { AuthService } from '../../modules/auth';
import type { IdentityService } from '../../modules/identity';
import { clearGuestSession } from '../../modules/guest/guest';

// Phones: a list of the sections that drills into each one.

const me = { id: '1', handle: 'alice', is_discoverable: true, encrypted_user_secret: '', created_at: '2026-01-01' };

function renderSettings(props: Partial<Parameters<typeof UserSettings>[0]> = {}) {
  return render(
    <UserSettings
      open onClose={() => {}} authedHandle="alice" authedEmail="alice@example.dev" onSignOut={() => {}}
      directory={{ getMe: vi.fn(async () => me) } as unknown as DirectoryService}
      identity={{ isUnlocked: () => true } as unknown as IdentityService}
      auth={{ updateMetadata: vi.fn(async () => undefined) } as unknown as AuthService}
      {...props}
    />,
  );
}

const original = window.matchMedia;
beforeEach(() => {
  clearGuestSession();
  window.matchMedia = ((q: string) => ({
    matches: true, media: q, onchange: null,
    addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
});
afterEach(() => { window.matchMedia = original; });

describe('UserSettings on a phone', () => {
  it('opens on the grouped list with hints, drills into a section, and comes back', () => {
    renderSettings();
    expect(screen.queryByRole('tab')).toBeNull();
    const row = screen.getByRole('button', { name: /^Bouncer: Off$/ });
    expect(screen.getByRole('button', { name: /^Account & security: alice@example.dev$/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Your profile: alice/ })).toBeInTheDocument();
    expect([...document.querySelectorAll('.user-settings-phone-heading')].map((h) => h.textContent))
      .toEqual(['You', 'App', 'Connections', 'About']);
    fireEvent.click(row);
    expect(screen.getByRole('heading', { level: 1, name: 'Bouncer' })).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'Use a bouncer' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Back to settings' }));
    expect(screen.getByRole('button', { name: /^Bouncer: Off$/ })).toBeInTheDocument();
    expect(screen.queryByRole('checkbox', { name: 'Use a bouncer' })).toBeNull();
  });

  it('a deep link (old names too) opens straight into its section', () => {
    renderSettings({ initialSection: 'content' });
    expect(screen.getByRole('heading', { level: 1, name: 'Chat & media' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Back to settings' }));
    expect(screen.getByRole('searchbox', { name: 'Search settings' })).toBeInTheDocument();
  });

  it('search narrows the list', () => {
    renderSettings();
    fireEvent.input(screen.getByRole('searchbox', { name: 'Search settings' }), { target: { value: 'push to talk' } });
    expect([...document.querySelectorAll('.user-settings-phone-list nav .bds-row-title')].map((t) => t.textContent)).toEqual([]);
    fireEvent.input(screen.getByRole('searchbox', { name: 'Search settings' }), { target: { value: 'youtube' } });
    expect([...document.querySelectorAll('.user-settings-phone-list nav .bds-row-title')].map((t) => t.textContent)).toEqual(['Chat & media']);
  });
});
