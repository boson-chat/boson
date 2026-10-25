import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/preact';
import { ServerSettings } from './ServerSettings';

function props(onClose = vi.fn()) {
  return {
    serverDisplayName: 'Boson HQ',
    myNick: 'alice',
    serverInfo: {},
    serverLog: [],
    onClearServerLog: vi.fn(),
    onClose,
    serverId: 'libera',
  } as Parameters<typeof ServerSettings>[0];
}

function phoneWidth(matches: boolean): void {
  window.matchMedia = ((query: string) => ({
    matches, media: query, onchange: null,
    addEventListener: () => {}, removeEventListener: () => {},
    addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
  })) as typeof window.matchMedia;
}

const realMatchMedia = window.matchMedia;
afterEach(() => { window.matchMedia = realMatchMedia; });

describe('ServerSettings header', () => {
  it('leads with a back button on a phone', () => {
    phoneWidth(true);
    const onClose = vi.fn();
    render(<ServerSettings {...props(onClose)} />);
    const back = screen.getByRole('button', { name: 'Close settings' });
    expect(back.classList.contains('chat-pane-back')).toBe(true);
    expect(screen.queryByText('×')).toBeNull();
    fireEvent.click(back);
    expect(onClose).toHaveBeenCalled();
  });

  it('keeps the corner × on a wide window', () => {
    phoneWidth(false);
    render(<ServerSettings {...props()} />);
    expect(screen.getByRole('button', { name: 'Close settings' }).textContent).toBe('×');
  });
});
