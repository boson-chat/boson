import { describe, it, expect } from 'vitest';
import { shouldGroup, buildRenderItems, coalesceActivity, ACTIVITY_COLLAPSE_MIN } from './message-render';
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

describe('buildRenderItems — activity collapse', () => {
  const join = (id: string, text = 'x joined') => msg({ id, kind: 'join', text });
  const chat = (id: string, text = 'hi') => msg({ id, kind: 'message', text });

  it('leaves plain messages untouched', () => {
    const items = buildRenderItems([chat('1'), chat('2')]);
    expect(items).toEqual([
      { type: 'msg', msg: expect.objectContaining({ id: '1' }) },
      { type: 'msg', msg: expect.objectContaining({ id: '2' }) },
    ]);
  });

  it('renders a SHORT activity run inline (below threshold)', () => {
    const run = Array.from({ length: ACTIVITY_COLLAPSE_MIN - 1 }, (_, i) => join(`j${i}`));
    const items = buildRenderItems(run);
    expect(items).toHaveLength(ACTIVITY_COLLAPSE_MIN - 1);
    expect(items.every((it) => it.type === 'msg')).toBe(true);
  });

  it('collapses a LONG activity run into a single activity item', () => {
    const run = Array.from({ length: ACTIVITY_COLLAPSE_MIN + 5 }, (_, i) => join(`j${i}`));
    const items = buildRenderItems(run);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ type: 'activity' });
    expect(items[0].type === 'activity' && items[0].items).toHaveLength(ACTIVITY_COLLAPSE_MIN + 5);
  });

  it('mixes join/part/quit/system into one collapsed run, split by real messages', () => {
    const seq: ChatMessage[] = [
      chat('m1'),
      join('j1'), msg({ id: 'q1', kind: 'quit', text: 'a quit' }),
      msg({ id: 's1', kind: 'system', text: 'You joined ##frontend' }),
      msg({ id: 'p1', kind: 'part', text: 'b left' }), join('j2'),
      chat('m2'),
    ];
    const items = buildRenderItems(seq);
    expect(items.map((it) => it.type)).toEqual(['msg', 'activity', 'msg']);
    expect(items[1].type === 'activity' && items[1].items).toHaveLength(5);
  });
});

describe('coalesceActivity', () => {
  it('counts identical adjacent lines (the replayed self-join case)', () => {
    const items = Array.from({ length: 40 }, (_, i) =>
      msg({ id: `s${i}`, kind: 'system', text: 'You joined ##frontend' }));
    expect(coalesceActivity(items)).toEqual([{ text: 'You joined ##frontend', count: 40 }]);
  });

  it('keeps distinct lines separate but counts repeats within each', () => {
    const items: ChatMessage[] = [
      msg({ id: '1', kind: 'system', text: 'You joined ##frontend' }),
      msg({ id: '2', kind: 'system', text: 'You joined ##frontend' }),
      msg({ id: '3', kind: 'quit', text: 'skdoo quit' }),
      msg({ id: '4', kind: 'join', text: 'skdoo joined' }),
    ];
    expect(coalesceActivity(items)).toEqual([
      { text: 'You joined ##frontend', count: 2 },
      { text: 'skdoo quit', count: 1 },
      { text: 'skdoo joined', count: 1 },
    ]);
  });
});
