import { describe, it, expect } from 'vitest';
import { tokenizeMarkdown } from './markdown';

describe('tokenizeMarkdown', () => {
  it('returns a single text token for plain prose', () => {
    expect(tokenizeMarkdown('hello world')).toEqual([
      { type: 'text', value: 'hello world' },
    ]);
  });

  it('parses **bold**', () => {
    expect(tokenizeMarkdown('say **hi** there')).toEqual([
      { type: 'text', value: 'say ' },
      { type: 'bold', value: 'hi' },
      { type: 'text', value: ' there' },
    ]);
  });

  it('parses *italic* and _italic_', () => {
    expect(tokenizeMarkdown('*one* and _two_')).toEqual([
      { type: 'italic', value: 'one' },
      { type: 'text', value: ' and ' },
      { type: 'italic', value: 'two' },
    ]);
  });

  it('parses ~~strikethrough~~', () => {
    expect(tokenizeMarkdown('was ~~old~~ now')).toEqual([
      { type: 'text', value: 'was ' },
      { type: 'strike', value: 'old' },
      { type: 'text', value: ' now' },
    ]);
  });

  it('parses inline `code`', () => {
    expect(tokenizeMarkdown('run `npm test`')).toEqual([
      { type: 'text', value: 'run ' },
      { type: 'code', value: 'npm test' },
    ]);
  });

  it('parses fenced ```code blocks``` (multi-line)', () => {
    const tokens = tokenizeMarkdown('see\n```\nlet x = 1;\n```\nok');
    expect(tokens).toEqual([
      { type: 'text', value: 'see\n' },
      { type: 'codeblock', value: '\nlet x = 1;\n' },
      { type: 'text', value: '\nok' },
    ]);
  });

  it('extracts bare URLs', () => {
    expect(tokenizeMarkdown('see https://example.com for more')).toEqual([
      { type: 'text', value: 'see ' },
      { type: 'link', value: 'https://example.com' },
      { type: 'text', value: ' for more' },
    ]);
  });

  it('does not greedily eat the trailing paren of a URL', () => {
    const tokens = tokenizeMarkdown('(check https://example.com)');
    const link = tokens.find((t) => t.type === 'link');
    expect(link?.value).toBe('https://example.com');
  });

  it('combines multiple inline tokens in one message', () => {
    expect(tokenizeMarkdown('**bold** plus *italic* plus `code`')).toEqual([
      { type: 'bold', value: 'bold' },
      { type: 'text', value: ' plus ' },
      { type: 'italic', value: 'italic' },
      { type: 'text', value: ' plus ' },
      { type: 'code', value: 'code' },
    ]);
  });
});
