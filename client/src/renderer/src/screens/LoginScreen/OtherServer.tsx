import { useEffect, useRef, useState } from 'preact/hooks';
import { Button, Field, Input } from '@boson/shared';
import { describeAuthError, guestAccessAllowed, type AuthConfig } from '../../modules/auth';
import { hostOf, type NetworkAccounts } from '../../modules/netauth/network-accounts';
import {
  enterToAddServer, enterWithServer, resolveOtherServer, type IrcTarget, type ResolveOutcome,
} from '../../modules/netauth/other-server';
import { NetworkSignInForm } from '../NetworkSignIn/NetworkSignIn';
import '../NetworkSignIn/NetworkSignIn.css';

// The login screen's "Use another server" step: the network's address,
// then its own sign-in (the per-network form), or a guest / plain IRC way
// in when it has no accounts.
interface Props {
  accounts: NetworkAccounts | null;
  initialAddress?: string;
  onBack: () => void;
  // The address being used (the login screen's server line shows it).
  onAddress?: (address: string | null) => void;
  // The found network's IRC host (its branding is looked up by it).
  onNetworkHost?: (host: string | null) => void;
}

type Step =
  | { kind: 'address' }
  | { kind: 'resolved'; outcome: ResolveOutcome }
  // A nick for a guest connect (guest) or for the manual add (plain).
  | { kind: 'nick'; mode: 'guest' | 'plain'; outcome: ResolveOutcome; name: string; irc: IrcTarget | null };

export function OtherServer({ accounts, initialAddress = '', onBack, onAddress, onNetworkHost }: Props) {
  const [address, setAddress] = useState(initialAddress);
  const [step, setStep] = useState<Step>({ kind: 'address' });
  const [busy, setBusy] = useState(false);
  const live = useRef(true);
  useEffect(() => () => { live.current = false; }, []);

  const lookUp = (e: Event): void => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    void resolveOtherServer(accounts, address).then((outcome) => {
      if (!live.current) return;
      setBusy(false);
      setStep({ kind: 'resolved', outcome });
      onAddress?.(outcome.kind === 'ok' ? outcome.domain : null);
      onNetworkHost?.(outcome.kind === 'ok' || outcome.kind === 'no-accounts' ? outcome.irc?.host.toLowerCase() ?? null : null);
    });
  };

  const change = (): void => {
    setStep({ kind: 'address' });
    onAddress?.(null);
    onNetworkHost?.(null);
  };

  if (step.kind === 'nick') {
    return <GuestNick step={step} accounts={accounts} onBack={() => setStep({ kind: 'resolved', outcome: step.outcome })} />;
  }

  if (step.kind === 'resolved' && step.outcome.kind === 'ok') {
    return (
      <NetworkStep
        accounts={accounts!}
        outcome={step.outcome}
        onChange={change}
        onGuest={(name) => setStep({ kind: 'nick', mode: 'guest', outcome: step.outcome, name, irc: (step.outcome as { irc: IrcTarget }).irc })}
      />
    );
  }

  const outcome = step.kind === 'resolved' ? step.outcome : null;
  return (
    <div class="otherserver">
      <form class="otherserver-form" onSubmit={lookUp}>
        <Field label="Server address" hint="A domain like example.com, an IRC host like irc.example.com, or a link to the network's site.">
          <Input
            aria-label="Server address"
            placeholder="example.com"
            value={address}
            onInput={(e) => { setAddress((e.target as HTMLInputElement).value); if (outcome) change(); }}
            autoFocus
            required
            autoComplete="url"
            autoCapitalize="off"
            spellcheck={false}
          />
        </Field>
        {outcome?.kind === 'error' && <div class="login-error" role="alert">{outcome.message}</div>}
        {outcome?.kind === 'main' && (
          <div class="login-notice" role="status">
            {outcome.address} is boson.chat's own network: it uses your boson.chat account.
          </div>
        )}
        {outcome?.kind === 'no-accounts' && <div class="login-notice" role="status">{outcome.message}</div>}

        <div class="login-actions">
          {outcome?.kind === 'main' ? (
            <Button type="button" variant="primary" fullWidth onClick={onBack}>Sign in to boson.chat</Button>
          ) : outcome?.kind === 'no-accounts' && outcome.irc ? (
            <Button
              type="button"
              variant="primary"
              fullWidth
              onClick={() => setStep({ kind: 'nick', mode: 'guest', outcome, name: outcome.address, irc: outcome.irc })}
            >
              Connect as guest
            </Button>
          ) : (
            <Button type="submit" variant="primary" fullWidth loading={busy} disabled={busy || !address.trim()}>
              {busy ? 'Looking up…' : 'Continue'}
            </Button>
          )}
          {(outcome?.kind === 'no-accounts' || (outcome?.kind === 'error' && outcome.plainIrc)) && (
            <Button
              type="button"
              variant="secondary"
              fullWidth
              onClick={() => setStep({ kind: 'nick', mode: 'plain', outcome, name: outcome.address, irc: null })}
            >
              Add as a plain IRC server
            </Button>
          )}
        </div>
      </form>
    </div>
  );
}

// A network with accounts: who it is, what it offers, and its sign-in.
function NetworkStep({ accounts, outcome, onChange, onGuest }: {
  accounts: NetworkAccounts;
  outcome: Extract<ResolveOutcome, { kind: 'ok' }>;
  onChange: () => void;
  onGuest: (name: string) => void;
}) {
  const { link, domain, irc } = outcome;
  const [cfg, setCfg] = useState<AuthConfig | null>(null);
  const [cfgError, setCfgError] = useState<string | null>(null);
  useEffect(() => {
    let on = true;
    accounts.config(link.authUrl, true).then((c) => { if (on) setCfg(c); }, (err) => { if (on) setCfgError(describeAuthError(err)); });
    return () => { on = false; };
  }, [accounts, link.authUrl]);

  const name = (cfg?.site_name || cfg?.network_name || '').trim() || domain;
  const registration = cfg?.registration ?? 'open';
  const guestOk = guestAccessAllowed(cfg);
  const providers = cfg?.sso_providers ?? [];
  const auth = accounts.service(link.authUrl);

  const signedIn = (): void => {
    accounts.nameIfUnnamed(link.authUrl, name);
    const user = auth.getState().session?.user;
    enterWithServer({
      accounts,
      server: { address: outcome.address, name, irc, authUrl: link.authUrl },
      nick: user?.username || user?.email || 'guest',
      asGuest: false,
    });
  };

  return (
    <div class="otherserver">
      <section class="otherserver-network" aria-label={`About ${name}`}>
        <div class="otherserver-network-head">
          <h2 class="otherserver-network-name">{name}</h2>
          <Button variant="ghost" size="sm" class="otherserver-change" onClick={onChange}>Change</Button>
        </div>
        {name !== domain && <span class="otherserver-network-site">{domain}</span>}
        {cfg && (
          <dl class="otherserver-facts">
            <dt>Accounts</dt>
            <dd>{registration === 'closed' ? 'Not taking new accounts' : registration === 'invite' ? 'New accounts by invite' : 'Open sign-up'}</dd>
            <dt>Sign-in</dt>
            <dd>{['Password', ...providers.map((p) => p.display_name || p.slug)].join(', ')}</dd>
            <dt>Guests</dt>
            <dd>{guestOk ? 'Welcome on its IRC' : 'Account required'}</dd>
          </dl>
        )}
      </section>
      {cfgError && !cfg ? (
        <div class="login-error" role="alert">Couldn't reach {name}'s sign-in service: {cfgError}</div>
      ) : (
        <NetworkSignInForm
          auth={auth}
          authHost={hostOf(link.authUrl)}
          name={name}
          cfg={cfg}
          cfgError={null}
          reason="connect"
          guestOk={guestOk}
          canSignUp={registration !== 'closed'}
          inviteOnly={registration === 'invite'}
          guestLabel={`Continue as guest on ${name}`}
          onDone={(r) => {
            if (r === 'signed-in') signedIn();
            else if (r === 'guest') { accounts.nameIfUnnamed(link.authUrl, name); onGuest(name); }
          }}
        />
      )}
    </div>
  );
}

function GuestNick({ step, accounts, onBack }: {
  step: Extract<Step, { kind: 'nick' }>;
  accounts: NetworkAccounts | null;
  onBack: () => void;
}) {
  const [nick, setNick] = useState('');
  const submit = (e: Event): void => {
    e.preventDefault();
    const n = nick.trim();
    if (!n) return;
    if (step.mode === 'plain' || !step.irc) {
      enterToAddServer(n, step.irc?.host ?? step.outcome.address);
      return;
    }
    const authUrl = step.outcome.kind === 'ok' ? step.outcome.link.authUrl : undefined;
    enterWithServer({
      accounts,
      server: { address: step.outcome.address, name: step.name, irc: step.irc, ...(authUrl ? { authUrl } : {}) },
      nick: n,
      asGuest: true,
    });
  };
  return (
    <form class="otherserver otherserver-form" onSubmit={submit}>
      <Field
        label="Pick a nick"
        hint={step.mode === 'plain'
          ? `Your IRC nickname. Next you'll check ${step.outcome.address}'s port and TLS settings, then connect.`
          : `Your IRC nickname on ${step.name}. No account; data stays on this device.`}
      >
        <Input
          aria-label="Pick a nick"
          placeholder="your-nick"
          value={nick}
          onInput={(e) => setNick((e.target as HTMLInputElement).value)}
          autoFocus
          required
          autoComplete="off"
          spellcheck={false}
        />
      </Field>
      <div class="login-guest-actions">
        <Button type="button" variant="ghost" onClick={onBack}>Back</Button>
        <Button type="submit" variant="primary" disabled={!nick.trim()}>
          {step.mode === 'plain' ? 'Continue' : `Connect to ${step.name}`}
        </Button>
      </div>
    </form>
  );
}
