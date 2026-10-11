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
    // Shimmer bar along the strip's edge while connecting.
    expect(screen.getByRole('progressbar', { name: 'Connecting to Libera' })).toBeInTheDocument();
  });

  it('also shows on the no-channel empty state (offline bouncers have no channels yet)', () => {
    const { container } = renderArea({ bouncer: true, bouncerUpstream: 'disconnected' }, { channel: null, onBouncerConnect: vi.fn() });
    expect(banner(container)).not.toBeNull();
  });
});

describe('ChatArea — bouncer certificate prompt', () => {
  const FP = 'da:cb:07:eb:07:c9:34:7b:47:3e:95:a3:5e:85:b6:b2:aa:96:e2:f5:a7:4c:86:40:5e:4a:ee:5b:da:32:b4:d4';
  const info: ServerInfo = {
    bouncer: true, bouncerUpstream: 'disconnected',
    bouncerCert: { fingerprint: FP, reason: "hostname doesn't match" },
  };

  it('replaces the Connect strip with Trust / Don\'t trust', () => {
    const onTrust = vi.fn();
    const onReject = vi.fn();
    const { container } = render(
      <ChatArea
        channel={activeChannel()} myNick="alice" onSend={vi.fn()} serverName="Rizon"
        serverInfo={info} onBouncerConnect={vi.fn()}
        onTrustBouncerCert={onTrust} onRejectBouncerCert={onReject}
      />,
    );
    const b = banner(container)!;
    expect(b.dataset.state).toBe('certificate');
    expect(b).toHaveTextContent("Your bouncer doesn't trust Rizon's certificate (hostname doesn't match).");
    expect(b).toHaveTextContent(`SHA-256 ${FP}`);
    expect(screen.queryByRole('button', { name: 'Connect' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Trust certificate' }));
    fireEvent.click(screen.getByRole('button', { name: "Don't trust" }));
    expect(onTrust).toHaveBeenCalledTimes(1);
    expect(onReject).toHaveBeenCalledTimes(1);
  });

  it('shows on the no-channel empty state too', () => {
    const { container } = renderArea(info, { channel: null });
    expect(banner(container)?.dataset.state).toBe('certificate');
  });
});
