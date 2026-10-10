import { describe, it, expect, afterEach } from 'vitest';
import { act, screen, fireEvent, waitFor } from '@testing-library/preact';
import { mountChat } from './helpers';

// Bouncer upstream round-trip: the engine reports `bouncer-upstream`, the
// chat area surfaces the offline strip, and clicking Connect sends a
// `bouncer-connect` command tagged with the serverId over the WebSocket.

describe('bouncer upstream integration', () => {
  let cleanup: (() => void) | null = null;
  afterEach(() => { cleanup?.(); cleanup = null; });

  it('shows the offline strip, sends bouncer-connect, then clears once connected', async () => {
    const { ws, rendered, unmount } = await mountChat({ serverName: 'Libera' });
    cleanup = unmount;
    // The engine is connected to the bouncer (status) but the bouncer is
    // offline from the network.
    act(() => {
      ws._receive({ type: 'status', state: 'connected' });
      ws._receive({ type: 'bouncer-upstream', upstream: 'disconnected' });
    });

    expect(await screen.findByText(/Your bouncer isn't connected to Libera/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
    await waitFor(() => {
      const sent = ws.sent.map((s) => JSON.parse(s));
      expect(sent).toContainEqual({ type: 'bouncer-connect', params: { serverId: 'srv-test' } });
    });

    act(() => { ws._receive({ type: 'bouncer-upstream', upstream: 'connecting' }); });
    expect(await screen.findByText(/connecting to Libera…/)).toBeInTheDocument();

    act(() => { ws._receive({ type: 'bouncer-upstream', upstream: 'connected' }); });
    await waitFor(() => {
      expect(rendered.container.querySelector('.chat-bouncer-upstream-banner')).toBeNull();
    });
  });
});
