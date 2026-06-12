import { describe, it, expect, beforeEach } from 'vitest';
import { getAvatar, setAvatar, setAvatars, subscribeAvatars, avatarVersion } from './avatar-cache';

describe('avatar-cache', () => {
  beforeEach(() => {
    // Reset shared state between tests by clearing any known keys.
    setAvatar('s1', 'alice', null);
    setAvatar('s1', 'bob', null);
    setAvatar('s2', 'alice', null);
  });

  it('stores + resolves per (server, nick), case-insensitive on nick', () => {
    setAvatar('s1', 'Alice', 'https://cdn/x.png');
    expect(getAvatar('s1', 'alice')).toBe('https://cdn/x.png');
    expect(getAvatar('s1', 'ALICE')).toBe('https://cdn/x.png');
    // Different server is a separate namespace.
    expect(getAvatar('s2', 'alice')).toBeUndefined();
  });

  it('clears with a null/empty value', () => {
    setAvatar('s1', 'bob', 'https://cdn/b.png');
    expect(getAvatar('s1', 'bob')).toBe('https://cdn/b.png');
    setAvatar('s1', 'bob', null);
    expect(getAvatar('s1', 'bob')).toBeUndefined();
  });

  it('notifies subscribers + bumps version only on real change', () => {
    let hits = 0;
    const off = subscribeAvatars(() => { hits += 1; });
    const v0 = avatarVersion();
    setAvatar('s1', 'alice', 'https://cdn/x.png');
    expect(hits).toBe(1);
    expect(avatarVersion()).toBeGreaterThan(v0);
    // Same value again → no emit.
    setAvatar('s1', 'alice', 'https://cdn/x.png');
    expect(hits).toBe(1);
    off();
    setAvatar('s1', 'alice', 'https://cdn/y.png');
    expect(hits).toBe(1); // unsubscribed
  });

  it('bulk setAvatars applies all matches', () => {
    setAvatars('s1', [{ nick: 'alice', url: 'https://cdn/a.png' }, { nick: 'bob', url: 'https://cdn/b.png' }]);
    expect(getAvatar('s1', 'alice')).toBe('https://cdn/a.png');
    expect(getAvatar('s1', 'bob')).toBe('https://cdn/b.png');
  });
});
