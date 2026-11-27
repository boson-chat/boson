// "Use another server" on the login screen: sign in (or up) on a
// self-hosted boson network directly, without a boson.chat account.
//
// The user types the network's address; the desktop shell finds its
// boson.json and validates its auth service exactly like connect-time
// discovery (desktop/netauth.go Resolve → TrustNetworkAuth). The sign-in
// itself is the per-network one (NetworkAccounts' AuthService for that
// auth URL, NetworkSignIn's form). On success the app runs in guest mode
// for boson.chat — no boson.chat account — with the network added to the
// server list and connected with its account (irc-login.ts: OAUTHBEARER).

import { requestAddServer, requestJoin } from '../deep-link/deep-link';
import { clearGuestSession, emitGuestChange, loadGuestSession, saveGuestSession } from '../guest/guest';
import { sanitizeIrcNick } from '../identity/nick';
import type { NetworkAccounts, NetworkLink, ResolvedNetwork } from './network-accounts';
import { cleanFederation, type HomeAccount } from './federation';

export interface IrcTarget {
  host: string;
  port: number;
  tls: boolean;
}

// What the user typed, as a host name: example.com, irc.example.com:6697,
// https://example.com/…, ircs://irc.example.com. null when it isn't one.
// (The shell normalises again; this is for the form's own check.)
export function normalizeServerAddress(raw: string): string | null {
  let s = raw.trim();
  if (!s || s.length > 512) return null;
  if (s.includes('://')) {
    const m = /^([a-z][a-z0-9+.-]*):\/\//i.exec(s);
    const scheme = m?.[1]?.toLowerCase();
    if (!scheme || !['https', 'http', 'irc', 'ircs'].includes(scheme)) return null;
    let u: URL;
    try {
      // URL only parses a host for special schemes: read irc(s) as https.
      u = new URL(scheme.startsWith('irc') ? `https${s.slice(scheme.length)}` : s);
    } catch {
      return null;
    }
    if (u.username || u.password || !u.hostname) return null;
    s = u.hostname;
  } else {
    s = s.split(/[/?#]/, 1)[0] ?? '';
    const port = /^(.*):\d{1,5}$/.exec(s);
    if (port) s = port[1]!;
  }
  s = s.toLowerCase().replace(/\.$/, '');
  if (!s || s.length > 253) return null;
  const labels = s.split('.');
  if (labels.some((l) => !/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(l))) return null;
  return s;
}

export type ResolveOutcome =
  // A network with accounts: sign in there.
  | { kind: 'ok'; address: string; domain: string; irc: IrcTarget; link: NetworkLink }
  // The address is boson.chat's own network.
  | { kind: 'main'; address: string }
  // No accounts (or none the app can use): guest / plain IRC are offered,
  // with the IRC server when the network says where it is.
  | { kind: 'no-accounts'; address: string; irc: IrcTarget | null; message: string }
  // Nothing to connect to.
  | { kind: 'error'; address: string; message: string; plainIrc: boolean };

// Looks up what the user typed. Never throws.
export async function resolveOtherServer(accounts: NetworkAccounts | null, raw: string): Promise<ResolveOutcome> {
  const address = normalizeServerAddress(raw);
  if (!address) {
    return { kind: 'error', address: raw.trim(), plainIrc: false, message: 'Enter a server address like example.com or irc.example.com.' };
  }
  if (!accounts?.canResolve) {
    return { kind: 'error', address, plainIrc: false, message: 'This version of Boson can\'t look up other servers. Update the app, or add the server from the directory.' };
  }
  let r: ResolvedNetwork | null;
  try {
    r = await accounts.resolve(address);
  } catch {
    r = null;
  }
  if (!r) return { kind: 'error', address, plainIrc: true, message: `${address} didn't answer in time. Check the address and your connection, then try again.` };
  return outcomeOf(address, r);
}

export function outcomeOf(address: string, r: ResolvedNetwork): ResolveOutcome {
  const irc = r.irc?.host ? { host: r.irc.host, port: r.irc.port || 6697, tls: !!r.irc.tls } : null;
  if (!r.error && r.authUrl && irc) {
    if (r.main) return { kind: 'main', address };
    const f = cleanFederation(r.federation, true);
    const federation = f ? { ...f, domain: f.domain || r.domain || address } : null;
    return {
      kind: 'ok',
      address,
      domain: r.domain || address,
      irc,
      link: {
        host: irc.host.toLowerCase(), authUrl: r.authUrl, main: false,
        ...(r.directoryUrl ? { directoryUrl: r.directoryUrl } : {}),
        ...(federation ? { federation } : {}),
      },
    };
  }
  switch (r.error) {
    case 'invalid':
      return { kind: 'error', address, plainIrc: false, message: 'Enter a server address like example.com or irc.example.com.' };
    case 'unreachable':
      // The shell says whether the name exists (desktop/netauth.go): a
      // typo has no DNS record; a plain IRC server's host does, it just
      // has no web server.
      if (r.detail === 'not-found') {
        return { kind: 'error', address, plainIrc: false, message: `Couldn't find ${address}. Check the spelling and try again.` };
      }
      if (r.detail === 'host-exists') return notBoson(address);
      return {
        kind: 'error', address, plainIrc: true,
        message: `Couldn't reach ${address} as a Boson network. Check the spelling, or if it's an IRC server you can still chat there as a regular IRC server.`,
      };
    case 'no-boson-json':
      return notBoson(address);
    case 'no-accounts':
      return { kind: 'no-accounts', address, irc, message: `${r.domain || address} doesn't have accounts. You can still chat on its IRC as a guest.` };
    case 'untrusted':
      return { kind: 'no-accounts', address, irc, message: `${r.domain || address} names a sign-in service Boson won't use${r.detail ? ` (${r.detail})` : ''}. You can still chat on its IRC as a guest.` };
    case 'no-irc':
    default:
      return { kind: 'error', address, plainIrc: true, message: `${r.domain || address} doesn't say where its IRC server is${r.detail ? ` (${r.detail})` : ''}.` };
  }
}

function notBoson(address: string): ResolveOutcome {
  return { kind: 'error', address, plainIrc: true, message: `${address} isn't a Boson network. You can still chat there as a regular IRC server.` };
}

// ---- the last server used from the login screen ----

const LAST_KEY = 'boson.login.lastServer';

export interface LastServer {
  // What the user typed (normalised), shown on the login screen.
  address: string;
  name: string;
  irc: IrcTarget;
  // The network's auth service (absent: joined as a guest).
  authUrl?: string;
}

type LocalStore = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

function local(): LocalStore | null {
  try { return typeof localStorage === 'undefined' ? null : localStorage; } catch { return null; }
}

export function loadLastServer(store: LocalStore | null = local()): LastServer | null {
  try {
    const v = JSON.parse(store?.getItem(LAST_KEY) ?? 'null') as Partial<LastServer> | null;
    if (!v || typeof v.address !== 'string' || !v.irc || typeof v.irc.host !== 'string' || typeof v.irc.port !== 'number') return null;
    return {
      address: v.address,
      name: typeof v.name === 'string' && v.name ? v.name : v.address,
      irc: { host: v.irc.host, port: v.irc.port, tls: !!v.irc.tls },
      ...(typeof v.authUrl === 'string' && v.authUrl ? { authUrl: v.authUrl } : {}),
    };
  } catch {
    return null;
  }
}

export function saveLastServer(s: LastServer, store: LocalStore | null = local()): void {
  try { store?.setItem(LAST_KEY, JSON.stringify(s)); } catch { /* storage off */ }
}

export function clearLastServer(store: LocalStore | null = local()): void {
  try { store?.removeItem(LAST_KEY); } catch { /* storage off */ }
}

// ---- into the app ----

// Enters the app without a boson.chat account (guest mode, under nick),
// adds the network's IRC server and connects to it — with its account
// when signed in there (the connect finds the session), else as a guest.
export function enterWithServer(opts: {
  accounts: NetworkAccounts | null;
  server: LastServer;
  nick: string;
  asGuest: boolean;
}): void {
  const { accounts, server } = opts;
  accounts?.setGuestChosen(server.irc.host, opts.asGuest);
  saveLastServer(server);
  saveGuestSession({ nick: sanitizeIrcNick(opts.nick) || opts.nick });
  requestJoin({ host: server.irc.host, port: server.irc.port, tls: server.irc.tls, name: server.name });
  emitGuestChange();
}

// "Add as a plain IRC server": guest mode, then the directory's manual-add
// form with the host filled in.
export function enterToAddServer(nick: string, hostname: string): void {
  saveGuestSession({ nick: sanitizeIrcNick(nick) || nick });
  requestAddServer({ hostname });
  emitGuestChange();
}

// "Continue as alice@boson.chat" on a self-hosted web client's sign-in
// screen, whose network takes accounts from other Boson servers: the app
// runs in guest mode (no account of its own here), and its own network is
// signed in to with the home account like any other network
// (NetworkAccounts.mainAsNetwork); its IRC is then joined with that
// session. Throws FederationError, with guest mode undone.
export async function enterHomeFederated(opts: {
  accounts: NetworkAccounts;
  // The app's own network (NetworkAccounts.mainNetworkLink).
  link: NetworkLink;
  home: HomeAccount;
  irc?: IrcTarget | null;
  name: string;
}): Promise<void> {
  const { accounts, link, home, irc } = opts;
  const before = loadGuestSession();
  const nickOf = (n: string): string => sanitizeIrcNick(n) || n;
  // Guest mode first: it's what makes the app's own auth a network one.
  saveGuestSession({ nick: nickOf(home.username) });
  let handle: string | undefined;
  try {
    handle = (await accounts.signInFederated(link, home)).federated?.handle;
  } catch (err) {
    if (before) saveGuestSession(before); else clearGuestSession();
    throw err;
  }
  saveGuestSession({ nick: nickOf(handle || home.username) });
  if (irc?.host) requestJoin({ host: irc.host, port: irc.port, tls: irc.tls, name: opts.name });
  emitGuestChange();
}
