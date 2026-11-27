// The app's own network ("home"): the one whose account is the app's main
// account (props.auth, mainAuthUrl) and whose IRC server is the one the
// app starts on. It is boson.chat in the desktop and phone apps and on
// chat.boson.chat. The web client a self-hosted stack serves (its `web`
// profile) is that install's own: platform/web sets it from
// /boson-config.js (platform/web/config.ts homeNetworkOf) — its domain,
// its name and, from its boson.json, its IRC server. boson.chat is then
// just another server there ("Use another server", federated sign-in).
import { useEffect, useState } from 'preact/hooks';

export interface HomeIrc {
  host: string;
  port: number;
  tls: boolean;
}

export interface HomeNetwork {
  // Where the network's boson.json is: boson.chat, boson.example.org.
  domain: string;
  // What the UI calls it ("Signing in to …", "Back to …").
  name: string;
  // Not boson.chat: a self-hosted stack's own web client.
  selfHosted: boolean;
  // Its IRC server (boson.json irc), once known. Self-hosted only.
  irc?: HomeIrc;
}

export const BOSON_CHAT_HOME: HomeNetwork = Object.freeze({ domain: 'boson.chat', name: 'boson.chat', selfHosted: false });

let current: HomeNetwork = BOSON_CHAT_HOME;
const listeners = new Set<(h: HomeNetwork) => void>();

export function getHomeNetwork(): HomeNetwork {
  return current;
}

// Replaces the home network (null: back to boson.chat).
export function setHomeNetwork(home: HomeNetwork | null): void {
  const next = home ?? BOSON_CHAT_HOME;
  if (next === current) return;
  current = next;
  for (const fn of listeners) fn(current);
}

// Fills in what was found later (the name from the auth service, the IRC
// server from boson.json). Ignored for boson.chat.
export function updateHomeNetwork(patch: Partial<Pick<HomeNetwork, 'name' | 'irc'>>): void {
  if (!current.selfHosted) return;
  const name = patch.name?.trim() || current.name;
  const irc = patch.irc ?? current.irc;
  if (name === current.name && irc === current.irc) return;
  setHomeNetwork({ ...current, name, ...(irc ? { irc } : {}) });
}

export function onHomeNetworkChange(fn: (h: HomeNetwork) => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

export function useHomeNetwork(): HomeNetwork {
  const [home, setHome] = useState(current);
  useEffect(() => {
    setHome(current);
    return onHomeNetworkChange(setHome);
  }, []);
  return home;
}

// The network's own name from its auth service's /v1/config (site_name,
// network_name), when it gives one.
export function nameFromAuthConfig(cfg: { site_name?: string; network_name?: string } | null | undefined): string {
  return (cfg?.site_name || cfg?.network_name || '').trim().slice(0, 80);
}

// ---- starting on the home network's IRC ----

const JOINED_KEY = 'boson:home-joined:v1';

type LocalStore = Pick<Storage, 'getItem' | 'setItem'>;

function local(): LocalStore | null {
  try { return typeof localStorage === 'undefined' ? null : localStorage; } catch { return null; }
}

// A self-hosted web client starts on its own network's IRC server (its
// boson.json irc.host — on the stack, the gateway's route to the network's
// bouncer bridge), as boson.chat's own client is meant to start on
// boson.chat: added and connected once per device (and again after a
// sign-out, which forgets it), then like any server the user can leave.
// Returns whether it asked for the join.
export function joinHomeOnce(
  home: HomeNetwork,
  join: (p: { host: string; port: number; tls: boolean; name?: string }) => void,
  store: LocalStore | null = local(),
): boolean {
  if (!home.selfHosted || !home.irc?.host) return false;
  const host = home.irc.host.toLowerCase();
  let done: string[] = [];
  try {
    const v = JSON.parse(store?.getItem(JOINED_KEY) ?? '[]') as unknown;
    if (Array.isArray(v)) done = v.filter((x): x is string => typeof x === 'string');
  } catch { /* unreadable: start over */ }
  if (done.includes(host)) return false;
  try { store?.setItem(JOINED_KEY, JSON.stringify([...done, host].slice(-16))); } catch { /* storage off */ }
  join({ host, port: home.irc.port, tls: home.irc.tls, name: home.name });
  return true;
}
