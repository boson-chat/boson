// The web build's runtime settings: /boson-config.js (written by the web
// container from its environment, so one image serves any stack) sets
// window.bosonWebConfig before the app's module runs. Missing values fall
// back to the build's VITE_* defaults.
export interface WebConfig {
  authUrl?: string;
  apiUrl?: string;
  directoryUrl?: string;
  // The IRC gateway's WebSocket URL (default: same origin /webirc/websocket/).
  gatewayUrl?: string;
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
