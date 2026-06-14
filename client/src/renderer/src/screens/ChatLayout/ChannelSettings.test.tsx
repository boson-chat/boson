import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/preact';
import type { ChatChannel } from '../../modules/chat';
import { ChannelSettings } from './ChannelSettings';

function chan(over: Partial<ChatChannel> = {}): ChatChannel {
  return {
    name: '#dev', joined: true, members: [], messages: [], typing: [],
    unread: 0, mentions: 0, topic: 'hi',
    modes: { flags: ['m'] },
    bans: [{ mask: 'troll!*@*', setBy: 'op' }],
    ...over,
  } as ChatChannel;
}

function renderSettings(over: { channel?: ChatChannel; myRank?: number } = {}) {
  const handlers = {
    onSetMode: vi.fn(), onSetTopic: vi.fn(), onAddBan: vi.fn(),
    onRemoveBan: vi.fn(), onRefresh: vi.fn(),
  };
  render(
    <ChannelSettings
      channel={over.channel ?? chan()}
      myRank={over.myRank ?? 3}
      {...handlers}
    />,
  );
  return handlers;
}

describe('ChannelSettings', () => {
  it('fetches modes + ban list on mount', () => {
    const h = renderSettings();
    expect(h.onRefresh).toHaveBeenCalledTimes(1);
  });

  it('renders the sections + reflects current modes/bans', () => {
    renderSettings();
    expect(screen.getByText('Modes')).toBeInTheDocument();
    expect(screen.getByText('Topic')).toBeInTheDocument();
    expect(screen.getByText('troll!*@*')).toBeInTheDocument();
    // +m is set → its checkbox is checked.
    const moderated = screen.getByLabelText('Moderated (+m)') as HTMLInputElement;
    expect(moderated.checked).toBe(true);
  });

  it('toggling a mode sends the composed fragment', () => {
    const h = renderSettings();
    fireEvent.click(screen.getByLabelText('Invite only (+i)')); // currently off → +i
    expect(h.onSetMode).toHaveBeenCalledWith('+i');
    fireEvent.click(screen.getByLabelText('Moderated (+m)')); // currently on → -m
    expect(h.onSetMode).toHaveBeenCalledWith('-m');
  });

  it('removing a ban calls onRemoveBan with the mask', () => {
    const h = renderSettings();
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    expect(h.onRemoveBan).toHaveBeenCalledWith('troll!*@*');
  });

  it('disables controls when not an operator', () => {
    renderSettings({ myRank: 1 }); // voice only
    expect((screen.getByLabelText('Moderated (+m)') as HTMLInputElement).disabled).toBe(true);
    expect(screen.getByText(/need channel operator/i)).toBeInTheDocument();
    expect((screen.getByRole('button', { name: 'Remove' }) as HTMLButtonElement).disabled).toBe(true);
  });
});
