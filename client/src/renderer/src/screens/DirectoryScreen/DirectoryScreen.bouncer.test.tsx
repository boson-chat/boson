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

describe('BouncerNetworksPanel — search', () => {
  const saved = (id: string, name: string, network: string) =>
    ({ id, name, hostname: 'znc.host', port: 6697, tls: true, bouncer: { route: true, network } }) as SavedServer;

  async function pullWith(found: string[], over: Partial<DirectoryBloc> = {}) {
    const bloc = stubBloc({ discoverBouncerNetworks: vi.fn(async () => found), ...over });
    render(<BouncerNetworksPanel bloc={bloc} connections={[]} />);
    fireEvent.click(screen.getByRole('button', { name: /Pull from bouncer/ }));
    await waitFor(() => expect(screen.getByText(found[0]!)).toBeInTheDocument());
    return bloc;
  }

  const search = () => screen.getByRole('searchbox', { name: 'Search networks' });

  it('is hidden until there is something to filter', () => {
    render(<BouncerNetworksPanel bloc={stubBloc()} connections={[]} />);
    expect(screen.queryByRole('searchbox', { name: 'Search networks' })).toBeNull();
  });

  it('filters discovered networks case-insensitively and shows a count', async () => {
    await pullWith(['libera', 'oftc', 'LiberaTest', '2600net']);
    fireEvent.input(search(), { target: { value: 'LIB' } });

    expect(screen.getByText('libera')).toBeInTheDocument();
    expect(screen.getByText('LiberaTest')).toBeInTheDocument();
    expect(screen.queryByText('oftc')).toBeNull();
    expect(screen.queryByText('2600net')).toBeNull();
    expect(screen.getByText('Found on your bouncer: 2 of 4')).toBeInTheDocument();
  });

  it('"Add N matching" adds only the visible, not-yet-added networks', async () => {
    const addBouncerNetwork = vi.fn();
    await pullWith(['libera', 'oftc', 'liberachat'], {
      addBouncerNetwork,
      bouncerNetworks: () => [saved('b1', 'libera', 'libera')],
    });
    fireEvent.input(search(), { target: { value: 'libera' } });

    fireEvent.click(screen.getByRole('button', { name: 'Add 1 matching' }));
    expect(addBouncerNetwork).toHaveBeenCalledTimes(1);
    expect(addBouncerNetwork).toHaveBeenCalledWith({ name: 'liberachat', network: 'liberachat' });
  });

  it('filters saved networks by display name or ZNC network', () => {
    const bloc = stubBloc({
      bouncerNetworks: () => [saved('b1', 'Libera Chat', 'libera'), saved('b2', 'My OFTC', 'oftc')],
    });
    render(<BouncerNetworksPanel bloc={bloc} connections={[]} />);

    fireEvent.input(search(), { target: { value: 'oftc' } });
    expect(screen.getByText('My OFTC')).toBeInTheDocument();
    expect(screen.queryByText('Libera Chat')).toBeNull();

    fireEvent.input(search(), { target: { value: 'nomatch' } });
    expect(screen.getByText(/None of your networks match/)).toBeInTheDocument();
  });

  it('Escape clears the search', async () => {
    await pullWith(['libera', 'oftc']);
    fireEvent.input(search(), { target: { value: 'oftc' } });
    expect(screen.queryByText('libera')).toBeNull();

    fireEvent.keyDown(search(), { key: 'Escape' });
    expect(screen.getByText('libera')).toBeInTheDocument();
  });
});
