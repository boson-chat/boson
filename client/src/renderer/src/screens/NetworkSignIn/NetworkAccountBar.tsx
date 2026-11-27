import { useEffect, useState } from 'preact/hooks';
import { UserRound } from 'lucide-preact';
import { Button } from '@boson/shared';
import { getNetworkAccounts, type NetworkAccounts, type NetworkAccountsSnapshot } from '../../modules/netauth/network-accounts';
import { signupMode } from '../../modules/auth';
import type { FederatedIdentity } from '../../modules/netauth/federation';
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
  const link = snap?.links[host.trim().toLowerCase()] ?? null;
  // A guest on the app's own network (a self-hosted web client): what an
  // account keeps, and whether one can be made here.
  const guestHere = !!accounts && !!link?.main && accounts.mainAsNetwork();
  const [canSignUp, setCanSignUp] = useState<boolean | null>(null);
  useEffect(() => {
    if (!guestHere || !accounts || !link) return;
    let live = true;
    accounts.config(link.authUrl).then((c) => { if (live) setCanSignUp(signupMode(c) !== 'closed'); }, () => {});
    return () => { live = false; };
  }, [guestHere, accounts, link?.authUrl]);
  if (!accounts || !snap) return null;
  if (!link || (link.main && !accounts.mainAsNetwork())) return null;
  const name = accounts.nameFor(link.authUrl, serverName);
  const session = accounts.sessionFor(link);
  if (session) {
    const fed = session.federated;
    const user = fed?.handle || session.user.username;
    return (
      <div
        class="netauth-bar"
        title={fed ? `Signed in to ${name} as ${user} with your ${fed.identity} account` : `Signed in to ${name} as ${user}`}
      >
        <UserRound size={12} aria-hidden="true" />
        <span class="netauth-bar-text">
          <span class="netauth-bar-user">{user}</span>
          {fed && <span class="netauth-home-hint">@{fed.homeDomain}</span>} on {name}
        </span>
      </div>
    );
  }
  return (
    <div class={`netauth-bar${guestHere ? ' netauth-bar-guest' : ''}`}>
      {guestHere && (
        <span class="netauth-bar-hint" data-testid="guest-keep-hint">
          {canSignUp ? 'Create an account or sign in' : 'Sign in'} to keep your nick and history.
        </span>
      )}
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

// The federated identity you're signed in to host's network with (null:
// none, or a local account there).
export function useFederatedIdentity(host: string | undefined, accounts = getNetworkAccounts()): FederatedIdentity | null {
  const [snap, setSnap] = useState<NetworkAccountsSnapshot | null>(() => accounts?.getSnapshot() ?? null);
  useEffect(() => (accounts ? accounts.subscribe(setSnap) : undefined), [accounts]);
  if (!accounts || !snap || !host) return null;
  const link = snap.links[host.trim().toLowerCase()];
  if (!link || (link.main && !accounts.mainAsNetwork())) return null;
  return accounts.sessionFor(link)?.federated ?? null;
}
