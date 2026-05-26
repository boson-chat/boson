import { describe, it, expect, afterEach } from 'vitest';
import { screen, waitFor } from '@testing-library/preact';
import userEvent from '@testing-library/user-event';
import { mountChat } from './helpers';

// Chat-send round-trip: typing into the input + pressing Enter should send a
// PRIVMSG through the engine WebSocket, and the user should see an optimistic
// echo of their own message in the channel log. Also covers slash-command
// dispatch (/help opens the modal).

describe('chat send integration', () => {
  let cleanup: (() => void) | null = null;
  afterEach(() => { cleanup?.(); cleanup = null; });

  it('typing + Enter sends a PRIVMSG and echoes the message locally', async () => {
    const { chat, ws, unmount } = await mountChat({ myNick: 'me' });
    cleanup = unmount;

    // Bootstrap an active channel — the ChatService.input() entrypoint
    // requires one.
    chat.join('#general');
    // Acknowledge the channel by simulating JOIN echo from the server so
    // ChatService marks it joined + makes it active.
    ws._receive({
      type: 'event',
      event: { Kind: 'JOIN', From: 'me', Target: '#general', Message: '', Raw: '' },
    });

    // The textarea is now placeholder="Message #general" and ready for input.
    const ta = await screen.findByPlaceholderText('Message #general');
    const user = userEvent.setup();
    await user.click(ta);
    await user.type(ta, 'hello world');
    await user.keyboard('{Enter}');

    // Engine got the privmsg
    await waitFor(() => {
      const sent = ws.sent.map((s) => JSON.parse(s));
      expect(sent.some((c) => c.type === 'privmsg'
        && c.params?.target === '#general'
        && c.params?.message === 'hello world')).toBe(true);
    });

    // Optimistic echo lives in the chat area
    expect(await screen.findByText('hello world')).toBeInTheDocument();
  });

  it('/help input opens the slash-commands help modal', async () => {
    const { chat, ws, unmount } = await mountChat({ myNick: 'me' });
    cleanup = unmount;
    chat.join('#dev');
    ws._receive({
      type: 'event',
      event: { Kind: 'JOIN', From: 'me', Target: '#dev', Message: '', Raw: '' },
    });

    const ta = await screen.findByPlaceholderText('Message #dev');
    const user = userEvent.setup();
    // Open the slash autocomplete with `/`, then accept `/help`.
    // The first command in SLASH_COMMANDS is /join — we navigate to /help.
    // The cleanest route is to type the full command and Enter to send;
    // ChatService routes /help to feedback → bloc opens the modal.
    await user.click(ta);
    // Bypass the slash autocomplete cycling logic: bypass-mode is to type
    // the full word + a space so the popup closes, then Enter.
    await user.type(ta, '/help ');
    await user.keyboard('{Enter}');

    // ChatLayoutBloc renders the help modal as a dialog with title.
    expect(await screen.findByRole('dialog', { name: 'Slash commands' })).toBeInTheDocument();
  });
});
