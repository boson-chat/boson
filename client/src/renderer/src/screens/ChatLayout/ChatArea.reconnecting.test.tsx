import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/preact';
import userEvent from '@testing-library/user-event';
import { ChatArea } from './ChatArea';
import type { ChatChannel } from '../../modules/chat';

// With a channel open, losing the connection keeps the conversation on
// screen: a strip under the header says so (and offers Reconnect), and the
// composer waits for the connection. The full splash is for no channel.

const chan: ChatChannel = {
  name: '#general', joined: true, members: [], typing: [], unread: 0, mentions: 0, topic: '',
  messages: [{ id: '1', kind: 'message', from: 'bob', text: 'still here', timestamp: 1000 } as ChatChannel['messages'][number]],
};

describe('ChatArea — reconnecting with a channel open', () => {
  it('keeps the messages and shows the strip instead of the splash', () => {
    const { container } = render(
      <ChatArea channel={chan} myNick="me" onSend={vi.fn()} engineState="connecting" reconnectActive serverName="HQ" serverLog={[]} />,
    );
    expect(screen.getByText('still here')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Reconnecting…');
    expect(screen.queryByText(/Connecting to HQ/)).toBeNull();
    const box = container.querySelector('.chat-textarea') as HTMLTextAreaElement;
    expect(box.disabled).toBe(true);
    expect(box.placeholder).toBe('Waiting for the connection…');
  });

  it('offers Reconnect when disconnected, with the reason', async () => {
    const onReconnect = vi.fn();
    render(
      <ChatArea channel={chan} myNick="me" onSend={vi.fn()} engineState="disconnected" connectionError="ping timeout"
        onReconnect={onReconnect} serverName="HQ" serverLog={[]} />,
    );
    expect(screen.getByRole('status')).toHaveTextContent(/Disconnected.*ping timeout/);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Reconnect' }));
    expect(onReconnect).toHaveBeenCalledOnce();
  });

  it('shows no strip while connected', () => {
    const { container } = render(<ChatArea channel={chan} myNick="me" onSend={vi.fn()} engineState="connected" serverLog={[]} />);
    expect(container.querySelector('.chat-connection-strip')).toBeNull();
    expect((container.querySelector('.chat-textarea') as HTMLTextAreaElement).disabled).toBe(false);
  });
});
