// @vitest-environment jsdom
// jsdom: the document body is sanitised with DOMPurify, which happy-dom's
// tree walking breaks (see markdown-doc.test.ts).
import { describe, it, expect } from 'vitest';
import { createRef } from 'preact';
import { render } from '@testing-library/preact';
import { signal } from '@preact/signals';
import { MessageList } from './message-render';
import type { ChatMessage } from '../../modules/chat';

const t0 = new Date('2026-10-12T16:28:00Z').getTime();
const lines = (from: string, texts: string[]): ChatMessage[] =>
  texts.map((text, i) => ({ id: `${from}-${i}`, kind: 'message', from, text, timestamp: t0 + i * 900 }));

describe('MessageList — pasted markdown', () => {
  it('renders a paste as one message with a document body', () => {
    const { container } = render(
      <MessageList
        messages={signal(lines('ada', [
          '## Footnotes', ' ', 'A claim.[^1]', ' ', '| a | b |', '|---|---|', '| 1 | 2 |', ' ',
          '```json', '{ "hidden": true }', '```', ' ', '[^1]: A note.',
        ]))}
        members={[]}
        myNick="me"
        scrollRef={createRef()}
        channelName="#lobby"
      />,
    );
    expect(container.querySelectorAll('.message-row')).toHaveLength(1);
    const doc = container.querySelector('.md-doc')!;
    expect(doc.querySelector('h2')?.textContent).toBe('Footnotes');
    expect(doc.querySelectorAll('table td')).toHaveLength(2);
    expect(doc.querySelector('pre code.language-json')?.textContent).toContain('"hidden"');
    expect(doc.querySelector('.footnotes li')?.textContent).toContain('A note.');
    expect(container.textContent).not.toContain('```');
  });
});
