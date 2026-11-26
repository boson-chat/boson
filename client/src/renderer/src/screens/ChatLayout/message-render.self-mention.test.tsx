import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/preact';
import { MessageRow } from './message-render';
import type { ChatMessage } from '../../modules/chat';

const msg = (text: string): ChatMessage => ({
  id: '1', kind: 'message', from: 'alice', text, timestamp: Date.now(),
});

// In a channel our own nick is always in the member list, so the member-token
// pass claims it first — it must still carry the self-mention highlight.
describe('MessageRow self mention', () => {
  it('highlights our nick as a self mention even though we are a member', () => {
    const { container } = render(
      <MessageRow msg={msg('Me: are you there?')} myNick="me" members={[{ nick: 'alice', prefix: '' }, { nick: 'me', prefix: '@' }]} />,
    );
    expect(container.querySelector('.message-row')!.classList.contains('message-row-mention')).toBe(true);
    const self = container.querySelector('.mention-self');
    expect(self?.textContent).toBe('Me');
    expect(self?.classList.contains('chat-token-mention')).toBe(true);
  });

  it('other members are plain member mentions', () => {
    const { container } = render(
      <MessageRow msg={msg('ask bob')} myNick="me" members={[{ nick: 'bob', prefix: '' }, { nick: 'me', prefix: '' }]} />,
    );
    expect(container.querySelector('.chat-token-mention')?.textContent).toBe('bob');
    expect(container.querySelector('.mention-self')).toBeNull();
  });

  it('sits flush against punctuation after it, not before a word', () => {
    const members = [{ nick: 'alice', prefix: '' as const }, { nick: 'me', prefix: '' as const }];
    const flushOf = (text: string, list = members) => render(<MessageRow msg={msg(text)} myNick="me" members={list} />)
      .container.querySelector('.mention-self')!.classList.contains('mention-flush');
    expect(flushOf('me: nice')).toBe(true);
    expect(flushOf('thanks me, really')).toBe(true);
    expect(flushOf('me nice')).toBe(false);
    // Not in the member list (the plain-text pass).
    expect(flushOf('me: nice', [{ nick: 'alice', prefix: '' }])).toBe(true);
    expect(flushOf('ask me later', [{ nick: 'alice', prefix: '' }])).toBe(false);
  });
});
