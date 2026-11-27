// The web build's runtime settings: /boson-config.js (written by the web
// container from its environment, so one image serves any stack) sets
// window.bosonWebConfig before the app's module runs. Missing values fall
// back to the build's VITE_* defaults.
import { BOSON_CHAT_HOME, type HomeNetwork } from '../../modules/netauth/home-network';
import { discoveryDomain } from './discovery';

export interface WebConfig {
  authUrl?: string;
  apiUrl?: string;
  directoryUrl?: string;
  // The IRC gateway's WebSocket URL (default: same origin /webirc/websocket/).
  gatewayUrl?: string;
  // The network this web client is the home of (its boson.json domain,
  // e.g. boson.example.org) and what to call it. Optional: by default the
  // domain is the auth service's (auth.boson.example.org → boson.example.org)
  // and the name is the auth service's own, else the domain.
  networkDomain?: string | null;
  networkName?: string | null;
  // e2e builds only: install the test hooks (window.bosonE2E).
  e2e?: boolean;
}

export function webConfig(): WebConfig {
  return (globalThis as { bosonWebConfig?: WebConfig }).bosonWebConfig ?? {};
}

export function gatewayUrl(cfg: WebConfig = webConfig(), loc: Location = location): string {
  const raw = cfg.gatewayUrl || '/webirc/websocket/';
  const u = new URL(raw, loc.href);
  if (u.protocol === 'http:') u.protocol = 'ws:';
  else if (u.protocol === 'https:') u.protocol = 'wss:';
  return u.toString();
}

const OFFICIAL_DOMAIN = 'boson.chat';

function cleanDomain(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  const d = raw.trim().toLowerCase().replace(/\.$/, '');
  if (!d || d.length > 253) return '';
  return d.split('.').every((l) => /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(l)) && d.includes('.') ? d : '';
}

function hostnameOf(u: string | undefined): string {
  try { return u ? new URL(u).hostname.toLowerCase() : ''; } catch { return ''; }
}

/**
 * The network this web client belongs to (modules/netauth/home-network.ts).
 * boson.chat (chat.boson.chat, and any build whose auth service is
 * boson.chat's) unless /boson-config.js names another networkDomain, or its
 * authUrl is on another domain: a self-hosted stack's own web client. An
 * auth service on loopback or an IP (dev, e2e) counts as boson.chat unless
 * networkDomain says otherwise.
 */
export function homeNetworkOf(cfg: WebConfig, defaultAuthUrl = 'https://auth.boson.chat'): HomeNetwork {
  const explicit = cleanDomain(cfg.networkDomain);
  const domain = explicit || discoveryDomain(hostnameOf(cfg.authUrl || defaultAuthUrl));
  if (!domain || domain === OFFICIAL_DOMAIN || (!explicit && domain === 'localhost')) return BOSON_CHAT_HOME;
  const name = (typeof cfg.networkName === 'string' ? cfg.networkName.trim().slice(0, 80) : '') || domain;
  return { domain, name, selfHosted: true };
}
