// ZNC administration for the bouncer specs, on top of a leased ZNC user
// (zncUser fixture): extra networks for discovery ("Pull from bouncer"),
// upstream connect / disconnect behind the app's back, and a clean-up that
// drops every network except the user's `ergo` one. Everything goes
// through a throwaway IRC client attached to the user's `ergo` network,
// talking to *status / *controlpanel like a person would.
import { randomBytes } from 'node:crypto';
import { IrcPeer, type IrcLine } from '../irc-peer';
import type { ZncUser } from './znc';

// Collects the bot's reply lines to one command: everything `bot` says
// from the moment the command is sent until it has been quiet for
// `quietMs` (ZNC answers in a burst; tables come as one line per row).
async function command(admin: IrcPeer, bot: string, text: string, quietMs = 400, timeoutMs = 10_000): Promise<string[]> {
  const from = admin.mark();
  admin.privmsg(bot, text);
  const fromBot = (l: IrcLine): boolean =>
    (l.command === 'PRIVMSG' || l.command === 'NOTICE') && l.prefix.split('!')[0] === bot;
  await admin.waitFor(fromBot, timeoutMs, `${bot} reply to "${text}"`, from);
  let seen = -1;
  for (;;) {
    const n = admin.lines.slice(from).filter(fromBot).length;
    if (n === seen) break;
    seen = n;
    await new Promise((r) => setTimeout(r, quietMs));
  }
  return admin.lines.slice(from).filter(fromBot).map((l) => l.params[1] ?? '');
}

export async function withZncAdmin<T>(u: ZncUser, fn: (run: (bot: string, text: string) => Promise<string[]>) => Promise<T>): Promise<T> {
  const admin = await IrcPeer.connect({
    host: u.host, port: u.port, nick: `zncadm${randomBytes(2).toString('hex')}`,
    pass: `${u.username}/${u.network}:${u.password}`,
  });
  try {
    return await fn((bot, text) => command(admin, bot, text));
  } finally {
    await admin.quit();
  }
}

// Network names from `*status ListNetworks` (a table: `| name | OnIRC | …`).
export function parseNetworkTable(lines: string[]): string[] {
  const names: string[] = [];
  for (const l of lines) {
    const m = /^\|\s*([^|\s]+)\s*\|/.exec(l);
    if (m && m[1] !== 'Network') names.push(m[1]!);
  }
  return names;
}

export async function listZncNetworks(u: ZncUser): Promise<string[]> {
  return withZncAdmin(u, async (run) => parseNetworkTable(await run('*status', 'ListNetworks')));
}

// Adds networks (no servers — discovery only needs them to exist).
export async function addZncNetworks(u: ZncUser, names: string[]): Promise<void> {
  await withZncAdmin(u, async (run) => {
    for (const n of names) {
      const reply = (await run('*controlpanel', `AddNetwork ${u.username} ${n}`)).join(' ');
      if (!/added|already exists/i.test(reply)) throw new Error(`AddNetwork ${n}: ${reply}`);
    }
  });
}

// Drops every network except the user's default one, so a test that added
// networks (or crashed before cleaning up) leaves the user as znc.conf has it.
export async function dropExtraZncNetworks(u: ZncUser): Promise<void> {
  await withZncAdmin(u, async (run) => {
    const names = parseNetworkTable(await run('*status', 'ListNetworks'));
    for (const n of names) {
      if (n.toLowerCase() === u.network.toLowerCase()) continue;
      await run('*controlpanel', `DelNetwork ${u.username} ${n}`);
    }
  });
}

// Connects / disconnects the user's network upstream from ANOTHER client —
// i.e. behind the app's back (another device, the ZNC webadmin, a dropped
// link). Resolves once ZNC has acknowledged the command.
export async function zncUpstream(u: ZncUser, action: 'connect' | 'disconnect' | 'jump'): Promise<string[]> {
  return withZncAdmin(u, (run) => run('*status', action));
}

// Whether ZNC reports the user's default network as on IRC (ListNetworks'
// "On IRC" column).
export async function zncOnIrc(u: ZncUser): Promise<boolean> {
  const lines = await withZncAdmin(u, (run) => run('*status', 'ListNetworks'));
  const row = lines.find((l) => new RegExp(`^\\|\\s*${u.network}\\s*\\|`, 'i').test(l));
  return /^\|[^|]*\|\s*Yes\s*\|/i.test(row ?? '');
}

// Adds a network whose only server is ergo's TLS listener. Its certificate
// is self-signed (infra/e2e/ergo.yaml), so ZNC refuses it and asks the user
// to trust the fingerprint: the certificate-prompt specs.
export async function addZncTlsNetwork(u: ZncUser, name: string): Promise<void> {
  await withZncAdmin(u, async (run) => {
    const added = (await run('*controlpanel', `AddNetwork ${u.username} ${name}`)).join(' ');
    if (!/added|already exists/i.test(added)) throw new Error(`AddNetwork ${name}: ${added}`);
    const server = (await run('*controlpanel', `AddServer ${u.username} ${name} ergo +6697`)).join(' ');
    if (!/added/i.test(server)) throw new Error(`AddServer ${name}: ${server}`);
  });
}
