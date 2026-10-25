import { describe, it, expect, vi, afterEach } from 'vitest';
import { act, render, screen } from '@testing-library/preact';
import userEvent from '@testing-library/user-event';
import { ChatArea, STRIP_DELAY_MS } from './ChatArea';
import type { ChatChannel } from '../../modules/chat';

// With a channel open, losing the connection keeps the conversation on
// screen. A strip under the header says so once it's taking a while (or at
// once when it needs the user); the composer stays usable — messages wait
// until the connection is back. The full splash is for no channel.

const chan: ChatChannel = {
  name: '#general', joined: true, members: [], typing: [], unread: 0, mentions: 0, topic: '',
  messages: [{ id: '1', kind: 'message', from: 'bob', text: 'still here', timestamp: 1000 } as ChatChannel['messages'][number]],
};

afterEach(() => { vi.useRealTimers(); });

describe('ChatArea — reconnecting with a channel open', () => {
  it('keeps the messages; the strip only once the reconnect takes a while', () => {
    vi.useFakeTimers();
    const { container } = render(
      <ChatArea channel={chan} myNick="me" onSend={vi.fn()} engineState="connecting" reconnectActive serverName="HQ" serverLog={[]} />,
    );
    expect(screen.getByText('still here')).toBeInTheDocument();
    expect(screen.queryByText(/Connecting to HQ/)).toBeNull();
    expect(container.querySelector('.chat-connection-strip')).toBeNull();
    act(() => { vi.advanceTimersByTime(STRIP_DELAY_MS); });
    expect(screen.getByRole('status')).toHaveTextContent('Reconnecting…');
    const box = container.querySelector('.chat-textarea') as HTMLTextAreaElement;
    expect(box.disabled).toBe(false);
  });

  it('a disconnect that has stopped retrying shows at once', async () => {
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
