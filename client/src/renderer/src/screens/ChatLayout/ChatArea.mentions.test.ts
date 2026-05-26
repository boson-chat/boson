import { describe, it, expect } from 'vitest';
import { stripMentionAts } from './chat-input.tokenize';

const members = [
  { nick: 'alice' },
  { nick: 'Bob' },
  { nick: 'scientist' },
];

describe('stripMentionAts', () => {
  it('replaces @nick with nick when nick is a known member', () => {
    expect(stripMentionAts('hey @scientist, whats up', members))
      .toBe('hey scientist, whats up');
  });

  it('handles a mention at the start of the line', () => {
    expect(stripMentionAts('@alice hi there', members)).toBe('alice hi there');
  });

  it('is case-insensitive on lookup, preserving the canonical nick casing', () => {
    expect(stripMentionAts('@bob, ping', members)).toBe('Bob, ping');
  });

  it('does NOT strip when nick is not a member (preserves bot triggers, emails)', () => {
    expect(stripMentionAts('@unknownbot hello', members)).toBe('@unknownbot hello');
    expect(stripMentionAts('email me at user@scientist.com', members))
      .toBe('email me at user@scientist.com');
  });

  it('handles multiple mentions in one message', () => {
    expect(stripMentionAts('@alice and @bob, look here', members))
      .toBe('alice and Bob, look here');
  });

  it('returns input unchanged when members list is empty', () => {
    expect(stripMentionAts('@anyone', [])).toBe('@anyone');
  });
});
