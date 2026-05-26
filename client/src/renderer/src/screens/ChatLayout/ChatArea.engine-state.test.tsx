import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/preact';
import userEvent from '@testing-library/user-event';
import { ChatArea } from './ChatArea';
import type { ServerLogEntry } from '../../modules/chat';

// These tests cover the engine-state branches in ChatArea: connecting splash,
// disconnected splash + Reconnect, and the log-panel toggle. The "connected
// + active channel" path is exercised by ChatLayout.test.tsx; here we drive
// ChatArea directly so the engine-state branching is isolated.

function makeLog(messages: string[]): ServerLogEntry[] {
  return messages.map((m, i) => ({
    id: String(i + 1),
    kind: 'NOTICE',
    from: 'server.example',
    target: 'me',
    message: m,
    timestamp: 1000 + i,
  }));
}

describe('ChatArea engine-state', () => {
  it("shows 'Connecting to {server}…' when engineState='connecting' and no active channel", () => {
    render(
      <ChatArea
        channel={null}
        myNick="me"
        onSend={vi.fn()}
        engineState="connecting"
        serverName="Boson HQ"
        serverLog={[]}
      />,
    );
    expect(screen.getByText(/Connecting to Boson HQ/)).toBeInTheDocument();
    // Status header reads "Connecting"
    expect(screen.getByText('Connecting')).toBeInTheDocument();
  });

  it("renders a live tail of recent serverLog entries inside the connecting splash", () => {
    const entries = makeLog(['looking up hostname', 'ident response', 'welcome banner']);
    render(
      <ChatArea
        channel={null}
        myNick="me"
        onSend={vi.fn()}
        engineState="connecting"
        serverName="Boson HQ"
        serverLog={entries}
      />,
    );
    expect(screen.getByText('looking up hostname')).toBeInTheDocument();
    expect(screen.getByText('ident response')).toBeInTheDocument();
    expect(screen.getByText('welcome banner')).toBeInTheDocument();
  });

  it("shows 'Disconnected from {server}' + Reconnect button when engineState='disconnected'", async () => {
    const onReconnect = vi.fn();
    render(
      <ChatArea
        channel={null}
        myNick="me"
        onSend={vi.fn()}
        engineState="disconnected"
        serverName="Boson HQ"
        onReconnect={onReconnect}
        serverLog={[]}
      />,
    );
    expect(screen.getByText(/Disconnected from Boson HQ/)).toBeInTheDocument();
    const btn = screen.getByRole('button', { name: 'Reconnect' });
    await userEvent.setup().click(btn);
    expect(onReconnect).toHaveBeenCalledOnce();
  });

  it("omits the Reconnect button when onReconnect prop is not provided", () => {
    render(
      <ChatArea
        channel={null}
        myNick="me"
        onSend={vi.fn()}
        engineState="disconnected"
        serverName="Boson HQ"
        serverLog={[]}
      />,
    );
    expect(screen.queryByRole('button', { name: 'Reconnect' })).toBeNull();
  });

  it("falls back to 'server' label when serverName is omitted", () => {
    render(
      <ChatArea
        channel={null}
        myNick="me"
        onSend={vi.fn()}
        engineState="connecting"
        serverLog={[]}
      />,
    );
    expect(screen.getByText(/Connecting to server…/)).toBeInTheDocument();
  });

  it("shows the legacy 'select a channel' stub when engineState='connected' and no active channel", () => {
    render(
      <ChatArea
        channel={null}
        myNick="me"
        onSend={vi.fn()}
        engineState="connected"
        serverName="Boson HQ"
        serverLog={[]}
      />,
    );
    expect(screen.getByText(/Select a channel from the sidebar/)).toBeInTheDocument();
    // No connecting / disconnected splash chrome.
    expect(screen.queryByText(/Connecting to/)).toBeNull();
    expect(screen.queryByText(/Disconnected from/)).toBeNull();
  });

  // Note: the engine log used to be a toggleable side-panel inside ChatArea.
  // It's been moved to the full-page ServerSettings screen (right-click a
  // server-rail tile → Server details → Engine log section). Tests that
  // exercised the in-chat panel have been removed; see ServerSettings.tsx.
});
