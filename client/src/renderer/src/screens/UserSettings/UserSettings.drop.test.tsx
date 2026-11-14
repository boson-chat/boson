// @vitest-environment jsdom
// jsdom, not happy-dom: happy-dom elements lack ondragenter/ondragover/…,
// so Preact would listen for "DragOver" and never see a real "dragover".
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/preact';
import { UserSettings } from './UserSettings';
import type { DirectoryService } from '../../modules/directory';
import type { AuthService } from '../../modules/auth';
import type { IdentityService } from '../../modules/identity';
import { clearGuestSession } from '../../modules/guest/guest';
import { drag, dropFiles } from '../../shared/FileDrop/drag-test-utils';

// Drag and drop onto the profile-image picker: a dropped file takes the same
// path as a chosen one (validation, upload, errors).

const me = { id: '1', handle: 'alice', is_discoverable: true, encrypted_user_secret: '', created_at: '2026-01-01' };

function renderSettings(uploadAvatar: DirectoryService['uploadAvatar']) {
  const directory = { getMe: vi.fn(async () => me), uploadAvatar } as unknown as DirectoryService;
  const auth = { updateMetadata: vi.fn(async () => undefined) } as unknown as AuthService;
  render(
    <UserSettings
      open onClose={() => {}} authedHandle="alice" authedEmail="alice@example.dev" onSignOut={() => {}}
      directory={directory} identity={{} as IdentityService} auth={auth}
    />,
  );
  const field = screen.getByText('Profile image').closest('.file-drop')!;
  return { field, directory };
}

const png = (bytes = 4) => new File([new Uint8Array(bytes)], 'me.png', { type: 'image/png' });

beforeEach(() => clearGuestSession());

describe('UserSettings — profile image drop', () => {
  it('uploads a dropped image, like choosing it', async () => {
    const uploadAvatar = vi.fn(async () => ({ ...me, avatar_url: 'https://cdn.example/a.png' }));
    const { field } = renderSettings(uploadAvatar);
    drag(field, 'dragenter');
    expect(screen.getByText('Drop to upload')).toBeInTheDocument();
    const file = png();
    const e = dropFiles(field, [file]);
    expect(e.defaultPrevented).toBe(true);
    expect(uploadAvatar).toHaveBeenCalledWith(file);
    expect(screen.queryByText('Drop to upload')).toBeNull();
    await screen.findByRole('button', { name: 'Change' });
  });

  it('shows the inline error for a non-image and does not upload', () => {
    const uploadAvatar = vi.fn();
    const { field } = renderSettings(uploadAvatar);
    dropFiles(field, [new File(['hi'], 'notes.txt', { type: 'text/plain' })]);
    expect(screen.getByText('Please choose an image file.')).toBeInTheDocument();
    expect(uploadAvatar).not.toHaveBeenCalled();
  });

  it('applies the same size limit as the picker', () => {
    const uploadAvatar = vi.fn();
    const { field } = renderSettings(uploadAvatar);
    dropFiles(field, [png(5 * 1024 * 1024 + 1)]);
    expect(screen.getByText('Image must be under 5 MB.')).toBeInTheDocument();
    expect(uploadAvatar).not.toHaveBeenCalled();
  });

  it('ignores drops while an upload is in flight', async () => {
    let finish!: () => void;
    const uploadAvatar = vi.fn(() => new Promise((r) => { finish = () => r({ ...me, avatar_url: 'https://cdn.example/a.png' }); }));
    const { field } = renderSettings(uploadAvatar as unknown as DirectoryService['uploadAvatar']);
    dropFiles(field, [png()]);
    await screen.findByRole('button', { name: 'Working…' });
    drag(field, 'dragenter');
    expect(screen.queryByText('Drop to upload')).toBeNull();
    dropFiles(field, [png()]);
    expect(uploadAvatar).toHaveBeenCalledTimes(1);
    finish();
    await screen.findByRole('button', { name: 'Change' });
  });

  it('keeps click-to-choose and the drop hint on the button', () => {
    const { field } = renderSettings(vi.fn());
    const input = field.querySelector<HTMLInputElement>('input[type="file"]')!;
    const click = vi.spyOn(input, 'click').mockImplementation(() => {});
    const button = screen.getByRole('button', { name: 'Upload' });
    button.click();
    expect(click).toHaveBeenCalled();
    expect(button).toHaveAccessibleDescription('or drop an image here');
  });

  it('a chosen file still uploads', async () => {
    const uploadAvatar = vi.fn(async () => ({ ...me, avatar_url: 'https://cdn.example/a.png' }));
    const { field } = renderSettings(uploadAvatar);
    const input = field.querySelector<HTMLInputElement>('input[type="file"]')!;
    const file = png();
    Object.defineProperty(input, 'files', { configurable: true, value: [file] });
    input.dispatchEvent(new Event('change', { bubbles: true }));
    await waitFor(() => expect(uploadAvatar).toHaveBeenCalledWith(file));
  });
});
