import { describe, it, expect, afterEach } from 'vitest';
import { render, screen } from '@testing-library/preact';
import { TitleBar } from './TitleBar';

const w = window as unknown as { bosonPlatform?: string };

afterEach(() => { delete w.bosonPlatform; });

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
