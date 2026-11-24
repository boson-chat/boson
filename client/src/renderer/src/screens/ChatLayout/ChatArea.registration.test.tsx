import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/preact';
import { ChatArea } from './ChatArea';
import type { ChatChannel } from '../../modules/chat';

const channel = {
  name: '#mine', joined: true, members: [], messages: [], typing: [], unread: 0, mentions: 0, topic: '',
} as unknown as ChatChannel;

describe('ChatArea — an operator\'s unregistered channel', () => {
  it('says "Unregistered" in words and offers to register it', () => {
    const onRegister = vi.fn();
    const onDismiss = vi.fn();
    const onOpenRegistration = vi.fn();
    render(
      <ChatArea
        channel={channel}
        myNick="me"
        onSend={vi.fn()}
        registration={{ registered: false, atRisk: true }}
        onOpenRegistration={onOpenRegistration}
        registerPrompt={{ onRegister, onDismiss }}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Unregistered' }));
    expect(onOpenRegistration).toHaveBeenCalled();
    expect(screen.getByRole('status')).toHaveTextContent('isn\'t registered');
    fireEvent.click(screen.getByRole('button', { name: 'Register #mine' }));
    expect(onRegister).toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Not now' }));
    expect(onDismiss).toHaveBeenCalled();
  });

  it('a registered channel keeps the quiet shield, no prompt', () => {
    render(<ChatArea channel={channel} myNick="me" onSend={vi.fn()} registration={{ registered: true, founder: 'me' }} onOpenRegistration={vi.fn()} />);
    expect(screen.queryByRole('button', { name: 'Unregistered' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Registered to me' })).toBeTruthy();
    expect(screen.queryByText(/isn't registered/)).toBeNull();
  });
});
