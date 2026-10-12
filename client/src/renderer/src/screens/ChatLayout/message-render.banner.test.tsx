import { describe, it, expect } from 'vitest';
import { createRef } from 'preact';
import { render } from '@testing-library/preact';
import { signal } from '@preact/signals';
import { MessageList } from './message-render';
import type { ChatMessage } from '../../modules/chat';

const at = new Date('2026-10-12T11:17:00Z').getTime();
const lines = (from: string, texts: string[]): ChatMessage[] =>
  texts.map((text, i) => ({ id: `${from}-${i}`, kind: 'message', from, text, timestamp: at }));

function renderList(messages: ChatMessage[]) {
  return render(
    <MessageList messages={signal(messages)} members={[]} myNick="me" scrollRef={createRef()} channelName="#elite-chat" />,
  );
}

describe('MessageList — ASCII-art banners', () => {
  it('draws a release bot\'s framed banners as cards', () => {
    const { container } = renderList(lines('[EWG]-L0VE', [
      '   \x0314______________________________________\x03   ',
      '  |   \x02New TV Release:\x02 South.Park.S29E01.720p.WEB.h264-DiRT |  ',
      '   ¯¯¯¯¯¯¯¯¯¯¯¯¯¯¯¯¯¯¯¯¯¯¯¯¯¯¯¯¯¯¯¯¯¯¯¯¯¯   ',
      '   ______________________________   ',
      '  |   New MOVIE Release: Gunche.2026.1080p |  ',
      '   ¯¯¯¯¯¯¯¯¯¯¯¯¯¯¯¯¯¯¯¯¯¯¯¯¯¯¯¯¯¯   ',
    ]));
    const cards = container.querySelectorAll('.message-banner');
    expect(cards).toHaveLength(2);
    expect([...container.querySelectorAll('.message-banner-label')].map((e) => e.textContent))
      .toEqual(['New TV Release', 'New MOVIE Release']);
    expect([...container.querySelectorAll('.message-banner-value')].map((e) => e.textContent))
      .toEqual(['South.Park.S29E01.720p.WEB.h264-DiRT', 'Gunche.2026.1080p']);
    // One header for the whole run, no raw art left over.
    expect(container.querySelectorAll('.message-preblock')).toHaveLength(1);
    expect(container.textContent).not.toMatch(/[_¯|]{2,}/);
  });

  it('keeps other ASCII art as aligned monospace', () => {
    const { container } = renderList(lines('bot', ['╔═════════╗', '║ ( o.o ) ║', '╚═════════╝']));
    expect(container.querySelector('.message-banner')).toBeNull();
    expect(container.querySelector('.message-preblock-pre')?.textContent).toContain('( o.o )');
  });
});
