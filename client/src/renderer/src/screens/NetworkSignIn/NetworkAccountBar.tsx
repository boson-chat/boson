import { useEffect, useState } from 'preact/hooks';
import { UserRound } from 'lucide-preact';
import { Button } from '@boson/shared';
import { getNetworkAccounts, type NetworkAccounts, type NetworkAccountsSnapshot } from '../../modules/netauth/network-accounts';
import './NetworkSignIn.css';

// Under a server's name in the channel sidebar: which account of the
// network's own you're on ("alice on Example Net"), or "Sign in to <network>"
// when it has accounts and you aren't signed in. Nothing for plain IRC
// networks and for boson.chat's own (its account is the app's).
export function NetworkAccountBar({ host, serverName, onSignedIn, accounts = getNetworkAccounts() }: {
  host: string;
  serverName: string;
  // After signing in here: reconnect, so IRC logs in with the account.
  onSignedIn?: () => void;
  accounts?: NetworkAccounts | null;
}) {
  const [snap, setSnap] = useState<NetworkAccountsSnapshot | null>(() => accounts?.getSnapshot() ?? null);
  useEffect(() => (accounts ? accounts.subscribe(setSnap) : undefined), [accounts]);
  useEffect(() => { void accounts?.discover(host); }, [accounts, host]);
  if (!accounts || !snap) return null;
  const link = snap.links[host.trim().toLowerCase()];
  if (!link || link.main) return null;
  const name = accounts.nameFor(link.authUrl, serverName);
  const session = accounts.sessionFor(link);
  if (session) {
    return (
      <div class="netauth-bar" title={`Signed in to ${name} as ${session.user.username}`}>
        <UserRound size={12} aria-hidden="true" />
        <span class="netauth-bar-text"><span class="netauth-bar-user">{session.user.username}</span> on {name}</span>
      </div>
    );
  }
  return (
    <div class="netauth-bar">
      <Button
        variant="secondary"
        size="sm"
        tone="accent"
        fullWidth
        class="netauth-bar-signin"
        onClick={() => {
          void accounts.promptSignIn({ link, serverName, reason: 'manage', allowGuest: false }).then((r) => {
            if (r === 'signed-in') onSignedIn?.();
          });
        }}
      >
        Sign in to {name}
      </Button>
    </div>
  );
}
