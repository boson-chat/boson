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

const MODERATED = 'Only people with a voice can talk';

describe('ChannelSettings', () => {
  it('fetches modes + ban list on mount', () => {
    const h = renderSettings();
    expect(h.onRefresh).toHaveBeenCalledTimes(1);
  });

  it('groups settings by intent in plain words + reflects current modes/bans', () => {
    renderSettings();
    for (const h of ['Topic', 'Who can join', 'Who can talk', 'Visibility', 'Bans (1)']) {
      expect(screen.getByRole('heading', { name: h })).toBeInTheDocument();
    }
    // No raw IRC mode letters in the labels.
    expect(document.querySelector('.chan-settings')!.textContent).not.toMatch(/\(\+[a-zA-Z]\)/);
    // A nick ban reads as the nick, the mask under it.
    expect(screen.getByText('troll')).toBeInTheDocument();
    expect(screen.getByText('troll!*@*')).toBeInTheDocument();
    // +m is set → its checkbox is checked.
    const moderated = screen.getByLabelText(MODERATED) as HTMLInputElement;
    expect(moderated.checked).toBe(true);
  });

  it('bans someone picked from the member list (by their host when known)', () => {
    const channel = chan({ members: [
      { nick: 'me', prefix: '@' }, { nick: 'troll', prefix: '', hostname: 'bad.example' }, { nick: 'boss', prefix: '@' },
    ] as ChatChannel['members'] });
    const handlers = { onSetMode: vi.fn(), onSetTopic: vi.fn(), onAddBan: vi.fn(), onRemoveBan: vi.fn(), onRefresh: vi.fn() };
    render(<ChannelSettings channel={channel} myRank={3} myNick="me" {...handlers} />);
    const ban = screen.getByRole('button', { name: 'Ban' }) as HTMLButtonElement;
    expect(ban.disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: /^Person to ban/ }));
    // Not ourselves, nor someone of our own rank.
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual(['troll']);
    fireEvent.click(screen.getByRole('option', { name: /troll/ }));
    fireEvent.click(ban);
    expect(handlers.onAddBan).toHaveBeenCalledWith('*!*@bad.example');
  });

  it('toggling a mode sends the composed fragment', () => {
    const h = renderSettings();
    fireEvent.click(screen.getByLabelText('Invite only')); // currently off → +i
    expect(h.onSetMode).toHaveBeenCalledWith('+i');
    fireEvent.click(screen.getByLabelText(MODERATED)); // currently on → -m
    expect(h.onSetMode).toHaveBeenCalledWith('-m');
  });

  it('removing a ban calls onRemoveBan with the mask', () => {
    const h = renderSettings();
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    expect(h.onRemoveBan).toHaveBeenCalledWith('troll!*@*');
  });

  it('disables controls when not an operator', () => {
    renderSettings({ myRank: 1 }); // voice only
    expect((screen.getByLabelText(MODERATED) as HTMLInputElement).disabled).toBe(true);
    expect(screen.getByText(/need channel operator/i)).toBeInTheDocument();
    expect((screen.getByRole('button', { name: 'Remove' }) as HTMLButtonElement).disabled).toBe(true);
  });
});
