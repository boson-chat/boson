// Who may create channels on a network (auth GET /v1/config
// `channel_creation`): anyone signed in ("registered", the default) or only
// admins ("admins": roles holding irc.chanreg — Ergo's
// operator-only-creation). With "admins", everyone else can only join
// channels that already exist (the network's channels, role channels,
// channels an admin made), so the Join dialog says so up front instead of
// letting a JOIN of a new name fail.
import { useEffect, useState } from 'preact/hooks';
import { useOptionalAuthService, type AuthConfig, type AuthService, type NetworkChannel, type Session } from '../auth';
import { getNetworkAccounts, type NetworkAccounts, type NetworkAccountsSnapshot } from '../netauth/network-accounts';
import { useVoice } from '../voice';

// The permission that lets a role create channels when creation is
// admins-only (auth's catalog: "irc." + the Ergo oper capability).
export const CHANREG_PERMISSION = 'irc.chanreg';

export const ADMINS_ONLY_TEXT = 'Only admins can create channels on this network.';

export interface ChannelCreation {
  // Creation is admins-only and this user isn't one.
  restricted: boolean;
  // The network's channels (from /v1/config `channels`), for suggestions.
  channels: NetworkChannel[];
}

export interface CreationWho {
  // Signed in to the network's account (not a guest).
  signedIn: boolean;
  // The account's effective permissions (GET /v1/me); null = unknown.
  permissions: readonly string[] | null;
  // An IRC operator on this connection (any irc.* role makes one).
  oper?: boolean;
}

function networkChannels(cfg: Partial<AuthConfig>): NetworkChannel[] {
  if (!Array.isArray(cfg.channels)) return [];
  return cfg.channels
    .filter((c): c is NetworkChannel => !!c && typeof c.name === 'string' && /^[#&]/.test(c.name))
    .map((c) => ({ name: c.name, ...(typeof c.topic === 'string' && c.topic ? { topic: c.topic } : {}), autojoin: c.autojoin === true }));
}

// null: nothing known (no config, or a server that predates the setting).
export function channelCreationFor(cfg: Partial<AuthConfig> | null | undefined, who: CreationWho): ChannelCreation | null {
  if (!cfg) return null;
  const channels = networkChannels(cfg);
  if (cfg.channel_creation !== 'admins') {
    return cfg.channel_creation === undefined && channels.length === 0 ? null : { restricted: false, channels };
  }
  const admin = !!who.oper || (who.signedIn && !!who.permissions?.includes(CHANREG_PERMISSION));
  return { restricted: !admin, channels };
}

// GET /v1/me permissions per (auth service, session), so every render
// doesn't ask again.
const permsCache = new Map<string, Promise<string[] | null>>();

export function permissionsFor(svc: AuthService, authKey: string, session: Session): Promise<string[] | null> {
  const key = `${authKey}\n${session.session_id || session.user.id}`;
  let p = permsCache.get(key);
  if (!p) {
    p = svc.me().then((m) => m.permissions, () => { permsCache.delete(key); return null; });
    permsCache.set(key, p);
  }
  return p;
}

export function resetCreationCache(): void {
  permsCache.clear();
}

interface Resolved {
  key: string;
  config: () => Promise<AuthConfig>;
  session: Session | null;
  service: AuthService;
}

// Which auth service speaks for `host`: the network's own (its boson.json),
// else the app's when it's the app's network (voice discovery says so).
function resolve(
  host: string,
  accounts: NetworkAccounts | null,
  mainAuth: AuthService | null,
  ours: boolean,
): Resolved | null {
  const link = accounts?.linkFor(host) ?? null;
  if (accounts && link) {
    const service = link.main && mainAuth ? mainAuth : accounts.service(link.authUrl);
    return { key: link.authUrl, config: () => accounts.config(link.authUrl), session: accounts.sessionFor(link), service };
  }
  if (ours && mainAuth && typeof mainAuth.config === 'function') {
    return { key: 'main', config: () => mainAuth.config(), session: mainAuth.getState().session, service: mainAuth };
  }
  return null;
}

// The creation policy for the active server, or null when unknown.
export function useChannelCreation(serverHost: string | undefined, opts: { oper?: boolean; guest?: boolean } = {}): ChannelCreation | null {
  const mainAuth = useOptionalAuthService();
  const accounts = getNetworkAccounts();
  const { snap: voice } = useVoice();
  const host = (serverHost ?? '').trim().toLowerCase();
  const ours = !!host && voice.servers[host]?.discovery === 'available';
  const [snap, setSnap] = useState<NetworkAccountsSnapshot | null>(() => accounts?.getSnapshot() ?? null);
  useEffect(() => (accounts ? accounts.subscribe(setSnap) : undefined), [accounts]);
  const [result, setResult] = useState<ChannelCreation | null>(null);

  const r = host ? resolve(host, accounts, mainAuth, ours) : null;
  const session = opts.guest ? null : (r?.session ?? null);
  const sig = `${host}\n${r?.key ?? ''}\n${session?.session_id ?? ''}\n${opts.oper ? 1 : 0}`;
  useEffect(() => {
    if (!r) { setResult(null); return; }
    let live = true;
    void (async () => {
      let cfg: AuthConfig | null = null;
      try { cfg = await r.config(); } catch { cfg = null; }
      let permissions: string[] | null = null;
      if (cfg?.channel_creation === 'admins' && session && !opts.oper) {
        permissions = await permissionsFor(r.service, r.key, session);
      }
      if (live) setResult(channelCreationFor(cfg, { signedIn: !!session, permissions, oper: opts.oper }));
    })();
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig, snap]);
  return r ? result : null;
}
