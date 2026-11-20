// soju.im/bouncer-networks: what bouncers that speak soju's protocol (soju,
// evrd) answer to `BOUNCER LISTNETWORKS` — one line per network, framed in a
// `soju.im/bouncer-networks` batch:
//
//   BOUNCER NETWORK <netid> name=Libera;host=irc.libera.chat;state=connected
//
// The attributes are encoded like IRCv3 message tags (`;`-separated
// key=value, values escaped as tag values). A `*` instead of attributes
// means the network was removed (bouncer-networks-notify).
//
// https://codeberg.org/emersion/soju/src/branch/master/doc/ext/bouncer-networks.md

export const BOUNCER_NETWORKS_CAP = 'soju.im/bouncer-networks';

// unescapeTagValue undoes IRCv3 message-tag value escaping.
function unescapeTagValue(v: string): string {
  let out = '';
  for (let i = 0; i < v.length; i++) {
    const c = v[i]!;
    if (c !== '\\') { out += c; continue; }
    const n = v[++i];
    if (n === undefined) break; // a trailing lone backslash is dropped
    out += n === ':' ? ';' : n === 's' ? ' ' : n === 'r' ? '\r' : n === 'n' ? '\n' : n;
  }
  return out;
}

// parseBouncerAttrs decodes a bouncer-networks attribute string. A key
// without a value (`key` or `key=`) maps to ''.
export function parseBouncerAttrs(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of s.split(';')) {
    if (!part) continue;
    const eq = part.indexOf('=');
    const key = eq < 0 ? part : part.slice(0, eq);
    if (!key) continue;
    out[key] = eq < 0 ? '' : unescapeTagValue(part.slice(eq + 1));
  }
  return out;
}

export interface BouncerNetwork {
  id: string;
  attrs: Record<string, string>;
}

// parseBouncerNetworkArgs reads a `BOUNCER NETWORK <netid> <attrs>` event's
// params (the engine forwards them as Args, subcommand first). null for
// anything else, and for a removal (`*`).
export function parseBouncerNetworkArgs(args: readonly string[] | undefined): BouncerNetwork | null {
  if (!args || args.length < 3 || args[0]!.toUpperCase() !== 'NETWORK') return null;
  const id = args[1]!;
  const raw = args[2]!;
  if (!id || raw === '*') return null;
  return { id, attrs: parseBouncerAttrs(raw) };
}

// bouncerNetworkNames is the networks' names (the `name` attribute, which is
// also what `PASS user/<network>:password` selects), deduped ignoring case,
// in the bouncer's order. A network without a name falls back to its netid.
export function bouncerNetworkNames(nets: readonly BouncerNetwork[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const n of nets) {
    const name = (n.attrs.name ?? '').trim() || n.id;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(name);
  }
  return out;
}
