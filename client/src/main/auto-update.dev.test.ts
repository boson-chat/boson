import { describe, it, expect, vi } from 'vitest';

// An unpackaged build (dev, e2e): startAutoUpdater bails before loading
// electron-updater, but the About panel's "Check for updates" still has to
// hear the "up to date" answer pushed to the window.
vi.mock('electron', () => ({ app: { isPackaged: false } }));

describe('startAutoUpdater in an unpackaged build', () => {
  it('pushes a manual check result to the window', async () => {
    const { startAutoUpdater, checkNow, getUpdateState } = await import('./auto-update');
    const send = vi.fn();
    const win = { isDestroyed: () => false, webContents: { send } };
    startAutoUpdater(win as unknown as import('electron').BrowserWindow);

    await checkNow();

    expect(getUpdateState()).toMatchObject({ kind: 'up-to-date' });
    expect(send).toHaveBeenCalledWith('updater:state', expect.objectContaining({ kind: 'up-to-date' }));
  });
});
