import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent, screen } from '@testing-library/preact';
import { ChatArea } from './ChatArea';
import type { ChatChannel, ServerInfo } from '../../modules/chat';

// The bouncer-upstream strip sits under the chat header on bouncer
// connections whose bouncer is reachable but NOT attached to the real
// network. It must never show for direct connections or a healthy upstream.

function activeChannel(): ChatChannel {
  return {
    name: '#general', joined: true, members: [], messages: [], typing: [],
    unread: 0, mentions: 0, topic: '',
  };
}

function renderArea(serverInfo: ServerInfo, opts: { channel?: ChatChannel | null; onBouncerConnect?: () => void } = {}) {
  return render(
    <ChatArea
      channel={opts.channel === undefined ? activeChannel() : opts.channel}
      myNick="alice"
      onSend={vi.fn()}
      serverName="Libera"
      serverInfo={serverInfo}
      onBouncerConnect={opts.onBouncerConnect}
    />,
  );
}

const banner = (c: Element) => c.querySelector('.chat-bouncer-upstream-banner') as HTMLElement | null;

describe('ChatArea — bouncer upstream strip', () => {
  it('does not render for a direct connection', () => {
    const { container } = renderArea({});
    expect(banner(container)).toBeNull();
  });

  it('does not render when upstream is connected or unknown', () => {
    const { container, rerender } = renderArea({ bouncer: true, bouncerUpstream: 'connected' });
    expect(banner(container)).toBeNull();
    rerender(<ChatArea channel={activeChannel()} myNick="alice" onSend={vi.fn()} serverInfo={{ bouncer: true }} />);
    expect(banner(container)).toBeNull();
  });

  it('disconnected: explains + Connect fires onBouncerConnect', () => {
    const onBouncerConnect = vi.fn();
    const { container } = renderArea({ bouncer: true, bouncerUpstream: 'disconnected' }, { onBouncerConnect });
    const b = banner(container)!;
    expect(b).not.toBeNull();
    expect(b.dataset.state).toBe('disconnected');
    expect(b).toHaveTextContent("Your bouncer isn't connected to Libera.");
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
    expect(onBouncerConnect).toHaveBeenCalledTimes(1);
  });

  it('prefers the IRC network name when the server reported one', () => {
    const { container } = renderArea({ bouncer: true, bouncerUpstream: 'disconnected', network: 'Libera.Chat' });
    expect(banner(container)).toHaveTextContent("isn't connected to Libera.Chat.");
  });

  it('connecting: progress copy, no Connect button', () => {
    const { container } = renderArea({ bouncer: true, bouncerUpstream: 'connecting' }, { onBouncerConnect: vi.fn() });
    const b = banner(container)!;
    expect(b.dataset.state).toBe('connecting');
    expect(b).toHaveTextContent('connecting to Libera…');
    expect(screen.queryByRole('button', { name: 'Connect' })).toBeNull();
  });

  it('also shows on the no-channel empty state (offline bouncers have no channels yet)', () => {
    const { container } = renderArea({ bouncer: true, bouncerUpstream: 'disconnected' }, { channel: null, onBouncerConnect: vi.fn() });
    expect(banner(container)).not.toBeNull();
  });
});
