import { describe, it, expect, afterEach } from 'vitest';
import { screen, waitFor } from '@testing-library/preact';
import userEvent from '@testing-library/user-event';
import { mountChat } from './helpers';

// Keyboard-driven slash + @-mention autocomplete. Drives the real
// ChatInputBloc by routing keystrokes through the rendered textarea.

describe('autocomplete integration', () => {
  let cleanup: (() => void) | null = null;
  afterEach(() => { cleanup?.(); cleanup = null; });

  it('/ opens the slash listbox; Tab cycles through every command; Escape dismisses', async () => {
    const { chat, ws, unmount } = await mountChat({ myNick: 'me' });
    cleanup = unmount;
    chat.join('#room');
    ws._receive({
      type: 'event',
      event: { Kind: 'JOIN', From: 'me', Target: '#room', Message: '', Raw: '' },
    });

    const ta = await screen.findByPlaceholderText('Message #room');
    const user = userEvent.setup();
    await user.click(ta);
    await user.type(ta, '/');

    // Listbox visible with all SLASH_COMMANDS entries.
    const listbox = await screen.findByRole('listbox', { name: 'Slash command autocomplete' });
    expect(listbox).toBeInTheDocument();
    const options = await screen.findAllByRole('option');
    expect(options.length).toBe(8);

    // Tab cycles in SLASH_COMMANDS order — keep this list in lockstep
    // with the SLASH_COMMANDS const in chat.service.ts.
    const cycle = ['/join ', '/part ', '/msg ', '/me ', '/away ', '/back ', '/clear ', '/help ', '/join '];
    for (const expected of cycle) {
      await user.keyboard('{Tab}');
      await waitFor(() => {
        expect((ta as HTMLTextAreaElement).value).toBe(expected);
      });
    }

    // Escape dismisses the popup (we go back to '/' first by re-typing).
    // The previous Tabs left input = "/join " — no listbox shown (it closes
    // when there's a space). Re-typing '/' alone re-opens it.
    await user.clear(ta);
    await user.type(ta, '/');
    expect(await screen.findByRole('listbox', { name: 'Slash command autocomplete' })).toBeInTheDocument();
    await user.keyboard('{Escape}');
    await waitFor(() => {
      expect(screen.queryByRole('listbox', { name: 'Slash command autocomplete' })).toBeNull();
    });
  });

  it('@ mention popup opens with seeded NAMREPLY members and Tab cycles', async () => {
    const { chat, ws, unmount } = await mountChat({ myNick: 'me' });
    cleanup = unmount;
    chat.join('#crew');
    ws._receive({
      type: 'event',
      event: { Kind: 'JOIN', From: 'me', Target: '#crew', Message: '', Raw: '' },
    });
    // Seed the channel's member list by pushing a NAMREPLY + ENDOFNAMES
    // through the engine. ChatService accumulates RPL_NAMREPLY tokens until
    // ENDOFNAMES commits them, so we need both.
    ws._receive({
      type: 'event',
      event: { Kind: '353', From: 'server', Target: '#crew', Message: '@Trevor +Tina taylor', Raw: '' },
    });
    ws._receive({
      type: 'event',
      event: { Kind: '366', From: 'server', Target: '#crew', Message: 'End of NAMES', Raw: '' },
    });

    const ta = await screen.findByPlaceholderText('Message #crew');
    const user = userEvent.setup();
    await user.click(ta);
    await user.type(ta, '@T');

    // Mention popup appears with the T-prefixed members (Trevor, Tina, but
    // not taylor — wait, taylor starts with lower-case t; the bloc's filter
    // is case-insensitive, so all three should match for "@T").
    const listbox = await screen.findByRole('listbox', { name: 'Mention autocomplete' });
    expect(listbox).toBeInTheDocument();
    const options = await screen.findAllByRole('option');
    // Three Ts: Trevor, Tina, taylor.
    expect(options.length).toBe(3);

    // Tab commits the first locale-sorted match. `localeCompare` puts
    // lowercase before uppercase in en-US, so the actual order is:
    //   taylor, Tina, Trevor
    await user.keyboard('{Tab}');
    await waitFor(() => {
      expect((ta as HTMLTextAreaElement).value).toBe('@taylor ');
    });
    // Subsequent Tab cycles forward — popup is closed (trailing space) but
    // the bloc has the cycle armed, so each Tab swaps in the next nick.
    await user.keyboard('{Tab}');
    await waitFor(() => {
      expect((ta as HTMLTextAreaElement).value).toBe('@Tina ');
    });
    await user.keyboard('{Tab}');
    await waitFor(() => {
      expect((ta as HTMLTextAreaElement).value).toBe('@Trevor ');
    });
  });
});
