// The boson network's channel policy, from the auth service's public config
// (GET /v1/config): whether new channels are registered automatically for
// the logged-in user who creates them, and whether unused channels expire.
//
// It only describes the network the app's auth service runs, so it applies
// to an IRC server only when that server is tied to the same auth service —
// which the voice discovery (.well-known/boson.json) already establishes.
import { useEffect, useState } from 'preact/hooks';
import { useOptionalAuthService, type AuthConfig, type AuthService } from '../auth';
import { useVoice } from '../voice';

export interface ChannelPolicy {
  autoRegister: boolean;
  // 0 = channels never expire.
  expiryDays: number;
}

export function channelPolicyFromConfig(cfg: Partial<AuthConfig> | null | undefined): ChannelPolicy | null {
  if (!cfg) return null;
  // An auth service that predates the settings says nothing: no policy.
  if (cfg.channel_auto_register === undefined && cfg.channel_expiry_days === undefined) return null;
  const days = Number(cfg.channel_expiry_days);
  return {
    autoRegister: cfg.channel_auto_register ?? true,
    expiryDays: Number.isFinite(days) && days > 0 ? Math.floor(days) : 0,
  };
}

const cache = new WeakMap<AuthService, Promise<ChannelPolicy | null>>();

function loadPolicy(auth: AuthService): Promise<ChannelPolicy | null> {
  let p = cache.get(auth);
  if (!p) {
    p = auth.config().then(channelPolicyFromConfig, () => null);
    cache.set(auth, p);
  }
  return p;
}

// The policy for `serverHost`, or null when it isn't the auth service's
// network (or nothing is known yet).
export function useChannelPolicy(serverHost: string | undefined): ChannelPolicy | null {
  const auth = useOptionalAuthService();
  const { snap } = useVoice();
  const ours = !!serverHost && snap.servers[serverHost.trim().toLowerCase()]?.discovery === 'available';
  const [policy, setPolicy] = useState<ChannelPolicy | null>(null);
  useEffect(() => {
    if (!ours || !auth || typeof auth.config !== 'function') { setPolicy(null); return; }
    let live = true;
    void loadPolicy(auth).then((p) => { if (live) setPolicy(p); });
    return () => { live = false; };
  }, [ours, auth]);
  return ours ? policy : null;
}
