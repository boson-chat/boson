import { describe, it, expect } from 'vitest';
import { sanitizeIrcNick } from './nick';

describe('sanitizeIrcNick', () => {
  it('passes a plain ASCII handle through unchanged', () => {
    expect(sanitizeIrcNick('alice')).toBe('alice');
  });

  it('replaces email-style chars (@ and .) with _', () => {
    expect(sanitizeIrcNick('james.trotter@joingotu.com')).toBe('james_trotter_jo');
  });

  it('truncates to 16 chars by default', () => {
    expect(sanitizeIrcNick('abcdefghijklmnopqrstuv')).toBe('abcdefghijklmnop');
  });

  it('respects an explicit maxLen', () => {
    expect(sanitizeIrcNick('alicelong', 5)).toBe('alice');
  });

  it('prepends _ when first char is a digit', () => {
    expect(sanitizeIrcNick('9bob')).toBe('_9bob');
  });

  it('prepends _ when first char is a hyphen', () => {
    expect(sanitizeIrcNick('-bob')).toBe('_-bob');
  });

  it('collapses runs of underscores after substitution', () => {
    expect(sanitizeIrcNick('a..b')).toBe('a_b');
  });

  it('trims trailing underscores left after substitution', () => {
    expect(sanitizeIrcNick('alice@')).toBe('alice');
  });

  it('falls back to "user" for empty input', () => {
    expect(sanitizeIrcNick('')).toBe('user');
  });

  it('falls back to "user" when every character is invalid', () => {
    expect(sanitizeIrcNick('...')).toBe('user');
  });

  it('keeps the special IRC-legal chars [ ] \\ ^ _ ` { } |', () => {
    expect(sanitizeIrcNick('a[]\\^_`{}|')).toBe('a[]\\^_`{}|');
  });
});
