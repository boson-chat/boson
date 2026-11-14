import { describe, expect, it } from 'vitest';
import { findListing } from './listing-match';
import type { Server } from './directory.types';

const row = (id: string, hostname: string, extra: Partial<Server> = {}): Server => ({
  id, hostname, port: 6697, tls: true, name: id, tags: [], languages: [], is_nsfw: false, is_featured: false,
  verification_status: 'verified', health_status: 'up', registered_at: '2026-01-01', ...extra,
});

describe('findListing', () => {
  const rows = [
    row('net_a', 'irc.a.example', { legacy_id: 'uuid-a' }),
    row('net_b', 'IRC.B.example'),
    row('net_c', 'irc.c.example', { port: 6667 }),
    row('net_c2', 'irc.c.example'),
  ];

  it('matches by id first', () => {
    expect(findListing({ id: 'net_b', hostname: 'irc.a.example', port: 6697 }, rows)?.id).toBe('net_b');
  });

  it('matches a legacy id', () => {
    expect(findListing({ id: 'uuid-a', hostname: 'elsewhere', port: 1 }, rows)?.id).toBe('net_a');
  });

  it('matches hostname (any case) + port, then hostname alone', () => {
    expect(findListing({ id: 'x', hostname: 'irc.b.EXAMPLE', port: 6697 }, rows)?.id).toBe('net_b');
    expect(findListing({ id: 'x', hostname: 'irc.c.example', port: 6697 }, rows)?.id).toBe('net_c2');
    expect(findListing({ id: 'x', hostname: 'irc.b.example', port: 6667 }, rows)?.id).toBe('net_b');
  });

  it('finds nothing for an unknown server or no rows', () => {
    expect(findListing({ id: 'x', hostname: 'irc.z.example', port: 6697 }, rows)).toBeUndefined();
    expect(findListing({ id: 'x', hostname: '', port: 6697 }, rows)).toBeUndefined();
    expect(findListing({ id: 'net_a', hostname: 'irc.a.example', port: 6697 }, null)).toBeUndefined();
  });
});
