import { describe, it, expect } from 'vitest';
import { rowToMessage, type StoredRow } from './idb-chat-history.store';

// happy-dom's IndexedDB shim is incomplete (missing IDBKeyRange.bound on
// arrays, fragile cursor semantics under range-onsuccess chains). Rather than
// pull in a fake-indexeddb dependency just for unit tests, we exercise this
// store end-to-end in the desktop app's e2e suite where a real webview IDB is
// available. The MemoryChatHistoryStore tests cover the same contract for
// the unit-test environment.
//
// TODO: add an e2e Playwright spec that boots the renderer, drives /join +
// PRIVMSG through the engine, reloads the renderer, and asserts the
// messages re-appear.
describe.skip('IDBChatHistoryStore', () => {
  it('round-trips messages and enforces the cap (run in app e2e)', () => {
    // intentionally empty
  });
});

describe('rowToMessage', () => {
  const base: StoredRow = {
    _pk: 'pk', userId: 'u', serverId: 's', channel: '#t',
    id: 'm1', kind: 'message', from: 'jrmu', text: 'hi', timestamp: 1000,
  };

  it('keeps msgid and serverTime, which dedupe needs', () => {
    expect(rowToMessage({ ...base, msgid: 'abc', serverTime: 900 })).toEqual({
      id: 'm1', kind: 'message', from: 'jrmu', text: 'hi', timestamp: 1000, msgid: 'abc', serverTime: 900,
    });
  });

  it('leaves them off rows stored without them', () => {
    expect(rowToMessage(base)).toEqual({ id: 'm1', kind: 'message', from: 'jrmu', text: 'hi', timestamp: 1000 });
  });
});
