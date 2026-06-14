import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/preact';
import { ServerSettings } from './ServerSettings';

// The per-server Bouncer tab toggles whether this connection routes through
// the user's global ZNC profile and names the ZNC network. It's always
// visible (configuring your own connection, not owner-gated).

function baseProps(overrides: Partial<Parameters<typeof ServerSettings>[0]> = {}) {
  return {
    serverDisplayName: 'Libera',
    myNick: 'alice',
    serverInfo: {},
    serverLog: [],
    onClearServerLog: vi.fn(),
    onClose: vi.fn(),
    serverId: 'libera',
    ...overrides,
  } as Parameters<typeof ServerSettings>[0];
}

const openBouncer = () => fireEvent.click(screen.getByRole('tab', { name: /Bouncer/ }));

describe('ServerSettings — Bouncer tab', () => {
  it('is present and saves the route via onSaveBouncerRoute', () => {
    const onSaveBouncerRoute = vi.fn();
    const p = baseProps({ bouncerGloballyEnabled: true, onSaveBouncerRoute });
    const { container } = render(<ServerSettings {...p} />);
    openBouncer();

    fireEvent.click(screen.getByLabelText('Route this server through the bouncer'));
    const network = container.querySelector('input[placeholder="libera"]') as HTMLInputElement;
    fireEvent.input(network, { target: { value: 'libera' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(onSaveBouncerRoute).toHaveBeenCalledWith({ route: true, network: 'libera' });
  });

  it('reflects an existing route', () => {
    const p = baseProps({
      bouncerGloballyEnabled: true,
      bouncerRoute: { route: true, network: 'oftc' },
      onSaveBouncerRoute: vi.fn(),
    });
    const { container } = render(<ServerSettings {...p} />);
    openBouncer();
    expect((screen.getByLabelText('Route this server through the bouncer') as HTMLInputElement).checked).toBe(true);
    expect((container.querySelector('input[placeholder="libera"]') as HTMLInputElement).value).toBe('oftc');
  });

  it('shows the "configure a bouncer first" banner when none is enabled globally', () => {
    const p = baseProps({ bouncerGloballyEnabled: false, onSaveBouncerRoute: vi.fn() });
    render(<ServerSettings {...p} />);
    openBouncer();
    expect(screen.getByText(/User Settings/)).toBeInTheDocument();
  });
});
