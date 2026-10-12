import { describe, it, expect } from 'vitest';
import { isMarkdownDocument, toWireLines } from './markdown-blocks';

describe('toWireLines', () => {
  it('trims a single line, as before', () => {
    expect(toWireLines('  hello  ')).toEqual(['hello']);
    expect(toWireLines('\n\n  hello\n\n')).toEqual(['hello']);
    expect(toWireLines('   ')).toEqual([]);
  });

  it('keeps indentation and turns blank lines into one space each run', () => {
    expect(toWireLines('- a\n  - b\n\n\n\npara  \n')).toEqual(['- a', '  - b', ' ', 'para']);
  });

  it('drops blank lines at either end', () => {
    expect(toWireLines('\n\n# T\nx\n\n')).toEqual(['# T', 'x']);
  });

  it('escapes lines that would read as commands', () => {
    expect(toWireLines('see:\n/join #x\n  /etc/hosts')).toEqual(['see:', '//join #x', '  //etc/hosts']);
  });

  it('accepts CRLF', () => {
    expect(toWireLines('a\r\nb')).toEqual(['a', 'b']);
  });
});

describe('isMarkdownDocument', () => {
  it('spots block syntax that spans lines', () => {
    expect(isMarkdownDocument(['```go', 'x := 1', '```'])).toBe(true);
    expect(isMarkdownDocument(['# Title', 'body'])).toBe(true);
    expect(isMarkdownDocument(['shopping:', '- eggs', '- milk'])).toBe(true);
    expect(isMarkdownDocument(['1. one', '2. two'])).toBe(true);
    expect(isMarkdownDocument(['> quoted', 'reply'])).toBe(true);
    expect(isMarkdownDocument(['| a | b |', '|---|:-:|', '| 1 | 2 |'])).toBe(true);
    expect(isMarkdownDocument(['$$', 'x^2', '$$'])).toBe(true);
  });

  it('leaves ordinary chat and ASCII art alone', () => {
    expect(isMarkdownDocument(['hi', 'how are you?'])).toBe(false);
    expect(isMarkdownDocument(['# just one line'])).toBe(false);
    expect(isMarkdownDocument(['- one', ' '])).toBe(false);
    expect(isMarkdownDocument(['   ______', '  |   New TV Release: x |', '   ¯¯¯¯¯¯'])).toBe(false);
    expect(isMarkdownDocument(['#channel is quiet', 'yeah'])).toBe(false);
    expect(isMarkdownDocument(['it costs $5', 'and $$$ later'])).toBe(false);
  });
});
