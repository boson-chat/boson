import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/preact';
import userEvent from '@testing-library/user-event';
import { UserSettings } from './UserSettings';
import pkg from '../../../../../package.json';

// UserSettings is mostly state-light (form fields + section switching);
// the interesting coverage here is the About panel surfaces the app
// version verbatim from package.json. Regression-protects against a
// rename that would silently drop the version display, and against
// the import path drifting after a file-move.

describe('UserSettings', () => {
  it('About section shows the app version, platform, and source link', async () => {
    render(
      <UserSettings
        open
        onClose={() => {}}
        authedHandle="alice"
        authedEmail="alice@example.dev"
        onSignOut={() => {}}
      />,
    );

    const user = userEvent.setup();
    await user.click(screen.getByRole('tab', { name: /About/ }));

    // Version is rendered with a leading "v" prefix in the value.
    expect(screen.getByText(`v${pkg.version}`)).toBeInTheDocument();
    // Source link points at the public repo. We don't fight the
    // anchor over how it opens (Electron's main process intercepts
    // and shell.openExternal-s these in production); just check the
    // href is right.
    const sourceLink = screen.getByRole('link', { name: /boson-chat\/boson/ });
    expect(sourceLink).toHaveAttribute('href', 'https://github.com/boson-chat/boson');
    // Release-notes link is version-pinned.
    const releaseLink = screen.getByRole('link', { name: new RegExp(`v${pkg.version} on GitHub`) });
    expect(releaseLink).toHaveAttribute(
      'href',
      `https://github.com/boson-chat/boson/releases/tag/v${pkg.version}`,
    );
  });
});
