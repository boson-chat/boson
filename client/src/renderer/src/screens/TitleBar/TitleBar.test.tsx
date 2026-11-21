import { describe, it, expect, afterEach, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/preact';
import { TitleBar } from './TitleBar';

const w = window as unknown as { bosonPlatform?: string; bosonShell?: string };

afterEach(() => { delete w.bosonPlatform; delete w.bosonShell; });

describe('TitleBar window controls', () => {
  it('draws minimize/maximize/close on Windows and Linux', () => {
    w.bosonPlatform = 'win32';
    render(<TitleBar />);
    expect(screen.getByRole('button', { name: 'Minimize' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Close' })).toBeTruthy();
  });

  it('leaves them to the native traffic lights on macOS', () => {
    w.bosonPlatform = 'darwin';
    render(<TitleBar />);
    expect(screen.queryByRole('button', { name: 'Minimize' })).toBeNull();
  });

  it('has none in the web build, where the browser has its own', () => {
    w.bosonShell = 'web';
    render(<TitleBar />);
    for (const name of ['Minimize', 'Maximize', 'Restore', 'Close']) {
      expect(screen.queryByRole('button', { name })).toBeNull();
    }
  });

  for (const platform of ['ios', 'android']) {
    it(`has none on ${platform}, where the window is the screen`, () => {
      w.bosonPlatform = platform;
      const { container } = render(<TitleBar />);
      for (const name of ['Minimize', 'Maximize', 'Restore', 'Close']) {
        expect(screen.queryByRole('button', { name })).toBeNull();
      }
      expect(container.querySelector('.title-bar-mobile')).not.toBeNull();
    });
  }
});

describe('TitleBar update indicator', () => {
  it('is absent until an update is ready', () => {
    render(<TitleBar onOpenSettings={() => {}} onOpenUpdate={() => {}} updateReady={null} />);
    expect(screen.queryByRole('button', { name: /restart to update/ })).toBeNull();
  });

  it('opens the update when one is ready', () => {
    const onOpenUpdate = vi.fn();
    render(<TitleBar onOpenSettings={() => {}} onOpenUpdate={onOpenUpdate} updateReady="9.0.0" />);
    fireEvent.click(screen.getByRole('button', { name: 'Boson v9.0.0 is ready — restart to update' }));
    expect(onOpenUpdate).toHaveBeenCalledOnce();
  });
});
