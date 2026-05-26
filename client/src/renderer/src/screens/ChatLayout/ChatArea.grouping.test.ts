import { describe, it, expect } from 'vitest';
import { shouldGroup } from './message-render';
import type { ChatMessage } from '../../modules/chat';

function msg(overrides: Partial<ChatMessage>): ChatMessage {
  return {
    id: '1',
    kind: 'message',
    from: 'alice',
    text: 'hi',
    timestamp: 1_000_000_000_000,
    ...overrides,
  };
}

describe('shouldGroup', () => {
  it('returns false when there is no previous message', () => {
    expect(shouldGroup(null, msg({}))).toBe(false);
  });

  it('groups two consecutive messages from the same sender', () => {
    const prev = msg({ id: '1', from: 'alice', timestamp: 1000 });
    const curr = msg({ id: '2', from: 'alice', timestamp: 2000 });
    expect(shouldGroup(prev, curr)).toBe(true);
  });

  it('does not group when senders differ', () => {
    const prev = msg({ id: '1', from: 'alice', timestamp: 1000 });
    const curr = msg({ id: '2', from: 'bob',   timestamp: 2000 });
    expect(shouldGroup(prev, curr)).toBe(false);
  });

  it('does not group when the time gap exceeds 5 minutes', () => {
    const prev = msg({ id: '1', from: 'alice', timestamp: 0 });
    const curr = msg({ id: '2', from: 'alice', timestamp: 6 * 60 * 1000 });
    expect(shouldGroup(prev, curr)).toBe(false);
  });

  it('does not group across different message kinds', () => {
    const prev = msg({ id: '1', from: 'alice', kind: 'message' });
    const curr = msg({ id: '2', from: 'alice', kind: 'notice' });
    expect(shouldGroup(prev, curr)).toBe(false);
  });

  it('never groups system / join / part / quit / action lines', () => {
    expect(shouldGroup(msg({}), msg({ kind: 'system' }))).toBe(false);
    expect(shouldGroup(msg({}), msg({ kind: 'join' }))).toBe(false);
    expect(shouldGroup(msg({}), msg({ kind: 'part' }))).toBe(false);
    expect(shouldGroup(msg({}), msg({ kind: 'quit' }))).toBe(false);
    expect(shouldGroup(msg({}), msg({ kind: 'action' }))).toBe(false);
  });
});
