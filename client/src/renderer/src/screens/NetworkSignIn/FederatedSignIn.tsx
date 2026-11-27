import { useEffect, useRef, useState } from 'preact/hooks';
import { ChevronRight } from 'lucide-preact';
import { Button } from '@boson/shared';
import type { NetworkAccounts, NetworkLink } from '../../modules/netauth/network-accounts';
import {
  acceptsFederation, describeFederationError, retryable, type HomeAccount,
} from '../../modules/netauth/federation';

// "Continue as alice@boson.chat": above a network's own sign-in, one
// choice per account the user already has on a Boson server that can vouch
// for them there (modules/netauth/federation.ts). Nothing when the network
// doesn't take accounts from elsewhere or there's no such account.
export function FederatedSignIn({ accounts, link, name, onSignedIn, onCreateAccount, homes: given, signIn, autoStart, divider }: {
  accounts: NetworkAccounts;
  link: NetworkLink;
  // The network's display name.
  name: string;
  onSignedIn: () => void;
  // "Create an account here instead" (absent: the network takes no new
  // accounts).
  onCreateAccount?: () => void;
  // The choices, when the caller already has them (tests, shots).
  homes?: HomeAccount[];
  // What a choice does (default: NetworkAccounts.signInFederated on link).
  signIn?: (home: HomeAccount) => Promise<unknown>;
  // Start with this identity at once (alice@boson.chat), e.g. right after
  // signing in there to come back here.
  autoStart?: string | null;
  // The divider under the choices (default "or use an account on <name>").
  divider?: string;
}) {
  const [homes, setHomes] = useState<HomeAccount[] | null>(given ?? null);
  const [busy, setBusy] = useState<string | null>(null);
  const [failure, setFailure] = useState<{ home: HomeAccount; message: string; retry: boolean } | null>(null);
  const live = useRef(true);
  useEffect(() => () => { live.current = false; }, []);
  useEffect(() => {
    if (given) { setHomes(given); return; }
    if (!acceptsFederation(link.federation, link.authUrl)) { setHomes([]); return; }
    let on = true;
    accounts.homeAccounts(link).then((h) => { if (on) setHomes(h); }, () => { if (on) setHomes([]); });
    return () => { on = false; };
  }, [accounts, link, given]);

  const go = (home: HomeAccount): void => {
    if (busy) return;
    setBusy(home.identity);
    setFailure(null);
    (signIn ? signIn(home) : accounts.signInFederated(link, home)).then(() => {
      if (!live.current) return;
      setBusy(null);
      onSignedIn();
    }, (err: unknown) => {
      if (!live.current) return;
      setBusy(null);
      setFailure({
        home,
        message: describeFederationError(err, {
          remote: name, identity: home.identity, homeDomain: home.domain, accepts: link.federation?.accepts,
        }),
        retry: retryable(err),
      });
    });
  };

  const started = useRef<string | null>(null);
  useEffect(() => {
    if (!autoStart || started.current === autoStart) return;
    const home = homes?.find((h) => h.identity === autoStart);
    if (!home) return;
    started.current = autoStart;
    go(home);
  });

  if (!homes || homes.length === 0) return null;

  return (
    <section class="netauth-fed" aria-label={`Sign in to ${name} with an account you already have`}>
      <span class="netauth-fed-label">Use an account you already have</span>
      <ul class="netauth-fed-list">
        {homes.map((h) => {
          const pending = busy === h.identity;
          return (
            <li key={h.identity}>
              <button
                type="button"
                class="netauth-fed-choice"
                disabled={busy !== null}
                aria-busy={pending || undefined}
                aria-label={`Continue as ${h.identity}`}
                aria-describedby={`netauth-fed-sub-${h.identity}`}
                onClick={() => go(h)}
              >
                <span class="netauth-fed-avatar" aria-hidden="true">{(h.username[0] ?? '?').toUpperCase()}</span>
                <span class="netauth-fed-body">
                  <span class="netauth-fed-title">
                    Continue as <span class="netauth-fed-user">{h.username}</span><span class="netauth-fed-domain">@{h.domain}</span>
                  </span>
                  <span class="netauth-fed-sub" id={`netauth-fed-sub-${h.identity}`}>
                    {pending ? `Asking ${h.domain} to vouch for you…` : `${h.domain} vouches for you. No password is shared.`}
                  </span>
                </span>
                {pending
                  ? <span class="login-sso-spinner netauth-fed-spinner" aria-hidden="true" />
                  : <ChevronRight size={16} class="netauth-fed-chevron" aria-hidden="true" />}
              </button>
            </li>
          );
        })}
      </ul>
      {failure && (
        <div class="netauth-fed-error" role="alert">
          <p class="netauth-fed-error-text">{failure.message}</p>
          <div class="netauth-fed-error-actions">
            {failure.retry && <Button variant="ghost" size="sm" onClick={() => go(failure.home)}>Try again</Button>}
            {onCreateAccount && (
              <Button variant="secondary" size="sm" onClick={() => { setFailure(null); onCreateAccount(); }}>
                Create an account here instead
              </Button>
            )}
          </div>
        </div>
      )}
      <div class="login-sso-divider netauth-fed-divider" aria-hidden="true"><span>{divider ?? `or use an account on ${name}`}</span></div>
    </section>
  );
}
