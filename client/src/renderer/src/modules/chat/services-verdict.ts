// services-verdict.ts — which services package (Atheme / Anope / Ergo) each
// server runs, as the engine detected it, kept between runs.
//
// The engine learns it by probing on welcome (VERSION, then HELP, to
// NickServ / ChanServ / HostServ). That traffic is noise: services log it,
// and history-keeping servers and bouncers store it as the user's DMs with
// those services. Handed back on the next connect (ConnectParams
// .servicesFramework), the engine skips the probe. "unknown" isn't kept, so
// a network whose verdict didn't settle is probed again next time.
//
// About the network, not the person: a device key (kept on sign-out).

export const SERVICES_VERDICT_KEY = 'boson:services-verdict:v1';
const KNOWN = new Set(['atheme', 'anope', 'ergo']);
// Servers remembered; the oldest entries go first.
const CAP = 500;

function storage(): Storage | null {
  try { return typeof localStorage === 'undefined' ? null : localStorage; } catch { return null; }
}

function read(s: Storage): Record<string, string> {
  try {
    const raw = s.getItem(SERVICES_VERDICT_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : null;
    if (!parsed || typeof parsed !== 'object') return {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === 'string' && KNOWN.has(v)) out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

/** The verdict remembered for this server, or undefined. */
export function loadServicesVerdict(serverId: string, s: Storage | null = storage()): string | undefined {
  if (!s || !serverId) return undefined;
  return read(s)[serverId];
}

/** Remember (or, for "unknown", forget) a server's verdict. */
export function saveServicesVerdict(serverId: string, framework: string, s: Storage | null = storage()): void {
  if (!s || !serverId) return;
  const all = read(s);
  if (!KNOWN.has(framework)) {
    if (!(serverId in all)) return;
    delete all[serverId];
  } else {
    if (all[serverId] === framework) return;
    delete all[serverId];
    all[serverId] = framework;
  }
  const keys = Object.keys(all);
  for (const k of keys.slice(0, Math.max(0, keys.length - CAP))) delete all[k];
  try { s.setItem(SERVICES_VERDICT_KEY, JSON.stringify(all)); } catch { /* full / blocked: probe next time */ }
}

export const servicesVerdicts = {
  load: (serverId: string) => loadServicesVerdict(serverId),
  save: (serverId: string, framework: string) => saveServicesVerdict(serverId, framework),
};
