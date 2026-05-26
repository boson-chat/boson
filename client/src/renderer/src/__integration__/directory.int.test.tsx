import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/preact';
import userEvent from '@testing-library/user-event';
import type { Server } from '../modules/directory';
import { EngineClient } from '../modules/engine';
import { FakeWebSocket, FakeWSCtor, jsonResponse, mockFetch, mountDirectory } from './helpers';

// Directory browse + search + filter + connect-to-chat round-trip. Drives the
// real DirectoryBloc through the view; only the network boundary is faked.

function srv(name: string, overrides: Partial<Server> = {}): Server {
  return {
    id: name, hostname: `irc.${name}`, port: 6697, tls: true, name,
    tags: [], languages: ['en'], is_nsfw: false, is_featured: false,
    verification_status: 'pending', health_status: 'unknown',
    registered_at: '2026-01-01',
    ...overrides,
  };
}

describe('directory integration', () => {
  let restoreFetch: (() => void) | null = null;
  beforeEach(() => { FakeWebSocket.reset(); });
  afterEach(() => { restoreFetch?.(); restoreFetch = null; vi.useRealTimers(); });

  it('renders initial servers, debounces search, applies language filter', async () => {
    const initial = [srv('Libera'), srv('OFTC')];
    const filtered = [srv('Libera')];
    const fossFr = [srv('FrenchServer', { languages: ['fr'] })];

    let queryHistory: string[] = [];
    // Custom dispatch: GET /servers returns initial, /servers?q=foss returns filtered.
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, _init?: RequestInit) => {
      const url = typeof input === 'string'
        ? input
        : input instanceof URL ? input.href : (input as Request).url;
      const parsed = new URL(url, 'http://test.local');
      if (parsed.pathname === '/me') {
        return jsonResponse({
          id: 'u1', handle: 'alice', is_discoverable: true,
          encrypted_user_secret: '', created_at: '2026-01-01',
        });
      }
      if (parsed.pathname === '/servers') {
        const q = parsed.searchParams.get('q') ?? '';
        queryHistory.push(q);
        if (q === 'foss') return jsonResponse({ servers: filtered, count: 1 });
        if (q) return jsonResponse({ servers: fossFr, count: 1 });
        return jsonResponse({ servers: initial, count: 2 });
      }
      return jsonResponse({ error: 'not mocked' }, 404);
    }) as unknown as typeof fetch;
    restoreFetch = () => { globalThis.fetch = originalFetch; };

    // Real-timer phase: just wait for the initial paint.
    mountDirectory();
    expect(await screen.findByText('Libera')).toBeInTheDocument();
    expect(screen.getByText('OFTC')).toBeInTheDocument();

    // Switch to fake timers for the debounce assertion. The DirectoryBloc
    // debounces 200 ms before re-querying /servers.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    queryHistory = [];
    await user.type(screen.getByPlaceholderText('Search servers…'), 'foss');
    await vi.advanceTimersByTimeAsync(250);
    await waitFor(() => {
      expect(queryHistory).toContain('foss');
    });

    // Language tab switch — filters in-memory only, no new network call.
    vi.useRealTimers();
    queryHistory = [];
    // Default language is 'all', click es tab.
    await userEvent.setup().click(screen.getByRole('tab', { name: 'Español' }));
    // No 'q'/lang param fetch was issued because the bloc filters locally.
    expect(queryHistory).toEqual([]);
  });

  it('Connect on a server hands off to ChatLayout once engine reaches connected', async () => {
    restoreFetch = mockFetch({
      'GET /me': () => jsonResponse({
        id: 'u1', handle: 'alice', is_discoverable: true,
        encrypted_user_secret: '', created_at: '2026-01-01',
      }),
      'GET /servers': () => jsonResponse({ servers: [srv('Libera')], count: 1 }),
    });

    const engine = new EngineClient(
      { url: 'ws://engine.test/ws', token: 't' },
      { wsCtor: FakeWSCtor, reconnect: false },
    );
    const opened = engine.open();
    FakeWebSocket.latest()!._open();
    await opened;

    mountDirectory({ engine });

    // Click Connect (the row's primary button)
    await screen.findByText('Libera');
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Connect' }));

    // The bloc has issued a ws send for {type:'connect'} and set engineState
    // to 'connecting'. We now drive the WS to deliver a connected status,
    // which the bloc consumes via onState — that flips showChat=true so the
    // view swaps to ChatLayout.
    const ws = FakeWebSocket.latest()!;
    await waitFor(() => {
      expect(ws.sent.some((s) => s.includes('"type":"connect"'))).toBe(true);
    });
    ws._receive({ type: 'status', serverId: 'Libera', state: 'connected' });
    // ChatLayout exposes a "Browse / switch servers" button (aria-label) in
    // the server rail — clicking it opens the directory modal rather than
    // tearing down the IRC session.
    expect(await screen.findByRole('button', { name: 'Browse / switch servers' })).toBeInTheDocument();
  });
});
