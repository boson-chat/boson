import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/preact';
import { ChatArea } from './ChatArea';
import type { ChatChannel } from '../../modules/chat';

// Input is held until the channel's JOIN is confirmed: nothing typed into a
// channel we aren't in yet would reach it.

const chan = (over: Partial<ChatChannel>): ChatChannel => ({
  name: '#general', joined: true, members: [], messages: [], typing: [],
  unread: 0, mentions: 0, topic: '', ...over,
});

const parts = (c: Element) => ({
  box: c.querySelector('.chat-textarea') as HTMLTextAreaElement,
  send: c.querySelector('.chat-send-btn') as HTMLButtonElement,
});

describe('ChatArea — composer while joining', () => {
  it('is disabled and says so until the channel is joined', () => {
    const { container, rerender } = render(<ChatArea channel={chan({ joined: false })} myNick="alice" onSend={vi.fn()} />);
    expect(parts(container).box.disabled).toBe(true);
    expect(parts(container).box.placeholder).toBe('Joining #general…');
    expect(parts(container).send.disabled).toBe(true);

    rerender(<ChatArea channel={chan({ joined: true })} myNick="alice" onSend={vi.fn()} />);
    expect(parts(container).box.disabled).toBe(false);
    expect(parts(container).box.placeholder).toBe('Message #general');
  });

  it('never holds a DM', () => {
    const { container } = render(<ChatArea channel={chan({ name: 'bob', joined: false })} myNick="alice" onSend={vi.fn()} />);
    expect(parts(container).box.disabled).toBe(false);
  });
});
