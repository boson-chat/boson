import { describe, it, expect } from 'vitest';
import { tokenizeMarkdown, isPreformattedLine } from './markdown';

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

  it('tokenizes ||spoiler||', () => {
    expect(tokenizeMarkdown('the killer is ||the butler||')).toEqual([
      { type: 'text', value: 'the killer is ' },
      { type: 'spoiler', value: 'the butler' },
    ]);
  });

  it('tokenizes :shortcode: emoji and lowercases it', () => {
    expect(tokenizeMarkdown('nice :TADA:')).toEqual([
      { type: 'text', value: 'nice ' },
      { type: 'emoji', value: 'tada' },
    ]);
  });

  it('does not treat clock times like 09:52:54 as emoji', () => {
    expect(tokenizeMarkdown('at 09:52:54')).toEqual([{ type: 'text', value: 'at 09:52:54' }]);
  });

  it('keeps a colon in a URL intact (URL wins over emoji)', () => {
    const t = tokenizeMarkdown('see https://x.com/a:b');
    expect(t.find((x) => x.type === 'link')?.value).toBe('https://x.com/a:b');
    expect(t.some((x) => x.type === 'emoji')).toBe(false);
  });
});

describe('isPreformattedLine', () => {
  it('detects box-drawing lines', () => {
    expect(isPreformattedLine('┌─────┬─────┐')).toBe(true);
    expect(isPreformattedLine('│ /home/x │ a bot │')).toBe(true);
    expect(isPreformattedLine('├─────┼─────┤')).toBe(true);
  });
  it('detects markdown pipe-table rows + separators', () => {
    expect(isPreformattedLine('| a | b | c |')).toBe(true);
    expect(isPreformattedLine('|---|:--:|---|')).toBe(true);
  });
  it('does not flag ordinary prose or a single short pipe', () => {
    expect(isPreformattedLine('just a normal message')).toBe(false);
    expect(isPreformattedLine('a | b')).toBe(false);
    expect(isPreformattedLine('hi')).toBe(false);
  });
});
