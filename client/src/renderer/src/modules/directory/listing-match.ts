import type { Server } from './directory.types';

// Which directory listing a connection (or saved server) is. Saved sessions
// key servers by the id they had when joined — for servers joined before the
// directory moved to /v1 that's the legacy uuid, which the /v1 rows (ids
// `net_…`) only carry as `legacy_id`, if at all. So match by id, then legacy
// id, then the address: hostname + port, then hostname alone (a saved plain
// 6667 entry is still the network listed on 6697).
export function findListing(
  server: { id: string; hostname: string; port: number },
  rows: readonly Server[] | null | undefined,
): Server | undefined {
  if (!rows || rows.length === 0) return undefined;
  const host = server.hostname.trim().toLowerCase();
  return rows.find((r) => r.id === server.id)
    ?? rows.find((r) => r.legacy_id !== undefined && r.legacy_id === server.id)
    ?? (host ? rows.find((r) => r.hostname.toLowerCase() === host && r.port === server.port) : undefined)
    ?? (host ? rows.find((r) => r.hostname.toLowerCase() === host) : undefined);
}
