import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/preact';
import { BouncerNetworksPanel } from './DirectoryScreen';
import type { DirectoryBloc } from './DirectoryBloc';
import type { SavedServer } from '../../modules/session';
import { SecureBouncerStore, setBouncerStore } from '../../modules/chat/bouncer.store';
import { InMemorySecureStorage } from '../../shared/secure-storage';

async function enableBouncer() {
  const s = new SecureBouncerStore(new InMemorySecureStorage(), { probeIntervalMs: 1, probeTimeoutMs: 5 });
  await s.whenHydrated();
  s.set({ enabled: true, host: 'znc.host', port: 6697, tls: true, tlsInsecure: false, username: 'me', password: 'pw' });
  setBouncerStore(s);
}

function stubBloc(over: Partial<DirectoryBloc> = {}): DirectoryBloc {
  return {
    bouncerNetworks: () => [] as SavedServer[],
    addBouncerNetwork: vi.fn(),
    discoverBouncerNetworks: vi.fn(async () => []),
    connectBouncerNetwork: vi.fn(),
    removeBouncerNetwork: vi.fn(),
    ...over,
  } as unknown as DirectoryBloc;
}

beforeEach(async () => { await enableBouncer(); });

describe('BouncerNetworksPanel — discovery', () => {
  it('pulls networks from the bouncer and lists them with Add', async () => {
    const addBouncerNetwork = vi.fn();
    const bloc = stubBloc({
      addBouncerNetwork,
      discoverBouncerNetworks: vi.fn(async () => ['libera', 'oftc']),
    });
    render(<BouncerNetworksPanel bloc={bloc} connections={[]} />);

    fireEvent.click(screen.getByRole('button', { name: /Pull from bouncer/ }));
    await waitFor(() => expect(screen.getByText('libera')).toBeInTheDocument());
    expect(screen.getByText('oftc')).toBeInTheDocument();

    // Add the first discovered network.
    const liberaRow = screen.getByText('libera').closest('.directory-bouncer-row') as HTMLElement;
    fireEvent.click(liberaRow.querySelector('button')!);
    expect(addBouncerNetwork).toHaveBeenCalledWith({ name: 'libera', network: 'libera' });
  });

  it('marks already-added networks as Added (no Add button)', async () => {
    const existing = { id: 'b1', name: 'libera', hostname: 'znc.host', port: 6697, tls: true,
      bouncer: { route: true, network: 'libera' } } as SavedServer;
    const bloc = stubBloc({
      bouncerNetworks: () => [existing],
      discoverBouncerNetworks: vi.fn(async () => ['libera', 'oftc']),
    });
    render(<BouncerNetworksPanel bloc={bloc} connections={[]} />);
    fireEvent.click(screen.getByRole('button', { name: /Pull from bouncer/ }));
    await waitFor(() => expect(screen.getAllByText('libera').length).toBeGreaterThan(0));
    // libera (already added) shows the "Added" badge.
    expect(screen.getByText('Added')).toBeInTheDocument();
  });

  it('surfaces a discovery error', async () => {
    const bloc = stubBloc({
      discoverBouncerNetworks: vi.fn(async () => { throw new Error('Bouncer did not respond'); }),
    });
    render(<BouncerNetworksPanel bloc={bloc} connections={[]} />);
    fireEvent.click(screen.getByRole('button', { name: /Pull from bouncer/ }));
    await waitFor(() => expect(screen.getByText(/Bouncer did not respond/)).toBeInTheDocument());
  });
});
