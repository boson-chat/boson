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

    // Auto-connect defaults ON for a server that never set it.
    expect(onSaveBouncerRoute).toHaveBeenCalledWith({ route: true, network: 'libera', autoConnect: true });
  });

  const AUTO = 'Automatically connect the network when the bouncer is disconnected';

  it('auto-connect toggle defaults on and persists false when turned off', () => {
    const onSaveBouncerRoute = vi.fn();
    const p = baseProps({
      bouncerGloballyEnabled: true,
      bouncerRoute: { route: true, network: 'libera' },
      onSaveBouncerRoute,
    });
    render(<ServerSettings {...p} />);
    openBouncer();
    const toggle = screen.getByLabelText(AUTO) as HTMLInputElement;
    expect(toggle.checked).toBe(true);
    fireEvent.click(toggle);
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(onSaveBouncerRoute).toHaveBeenCalledWith({ route: true, network: 'libera', autoConnect: false });
  });

  it('reflects a saved autoConnect=false', () => {
    const p = baseProps({
      bouncerGloballyEnabled: true,
      bouncerRoute: { route: true, network: 'libera', autoConnect: false },
      onSaveBouncerRoute: vi.fn(),
    });
    render(<ServerSettings {...p} />);
    openBouncer();
    expect((screen.getByLabelText(AUTO) as HTMLInputElement).checked).toBe(false);
  });

  it('hides the network status card when not attached via the bouncer', () => {
    render(<ServerSettings {...baseProps({ bouncerGloballyEnabled: true, bouncerUpstream: null })} />);
    openBouncer();
    expect(screen.queryByRole('button', { name: 'Connect network' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Disconnect network' })).toBeNull();
  });

  it('upstream disconnected: shows Network offline + Connect network', () => {
    const onBouncerConnect = vi.fn();
    render(<ServerSettings {...baseProps({
      bouncerGloballyEnabled: true,
      serverInfo: { bouncer: true, network: 'Libera.Chat' },
      bouncerUpstream: 'disconnected',
      onBouncerConnect,
      onBouncerDisconnect: vi.fn(),
    })} />);
    openBouncer();
    expect(screen.getByText('Network offline')).toBeInTheDocument();
    expect(screen.getByText(/isn't connected to Libera\.Chat/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Connect network' }));
    expect(onBouncerConnect).toHaveBeenCalledTimes(1);
  });

  it('upstream connected: shows Network connected + Disconnect network', () => {
    const onBouncerDisconnect = vi.fn();
    render(<ServerSettings {...baseProps({
      bouncerGloballyEnabled: true,
      bouncerUpstream: 'connected',
      onBouncerConnect: vi.fn(),
      onBouncerDisconnect,
    })} />);
    openBouncer();
    expect(screen.getByText('Network connected')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Connect network' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Disconnect network' }));
    expect(onBouncerDisconnect).toHaveBeenCalledTimes(1);
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
