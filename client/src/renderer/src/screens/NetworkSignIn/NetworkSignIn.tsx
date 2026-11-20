import { useEffect, useRef, useState } from 'preact/hooks';
import { Button, Field, Input, Modal, Tabs } from '@boson/shared';
import {
  AuthError, SSO_CANCELLED, describeAuthError, guestAccessAllowed, signInWithProvider, ssoBridge, validateUsername,
  type AuthConfig, type AuthService, type SSOProvider,
} from '../../modules/auth';
import { clearGuestSession, emitGuestChange } from '../../modules/guest/guest';
import {
  getNetworkAccounts, hostOf, type NetworkAccounts, type NetworkAccountsSnapshot, type SignInPrompt,
} from '../../modules/netauth/network-accounts';
import { getNetworkThemes, useNetworkBranding } from '../../modules/ui/theme';
import { NetworkBrandHero } from './NetworkBrand';
import '../LoginScreen/LoginScreen.css';
import './NetworkSignIn.css';

// "Sign in to <network>": the sign-in dialog for a network's own auth
// service (a self-hosted boson network), shown when connecting, when its IRC
// server wants an account, or from the server header / Settings. Mounted
// once at the app root; NetworkAccounts.promptSignIn drives it.
export function NetworkSignInHost({ accounts = getNetworkAccounts() }: { accounts?: NetworkAccounts | null }) {
  const [snap, setSnap] = useState<NetworkAccountsSnapshot | null>(() => accounts?.getSnapshot() ?? null);
  useEffect(() => (accounts ? accounts.subscribe(setSnap) : undefined), [accounts]);
  const prompt = snap?.prompt ?? null;
  // Keep the last prompt while the dialog animates out.
  const last = useRef<SignInPrompt | null>(null);
  if (prompt) last.current = prompt;
  const shown = prompt ?? last.current;
  if (!accounts || !shown) return null;
  const key = `${shown.link.authUrl}|${shown.link.host}|${shown.reason}`;
  return (
    <NetworkSignInDialog
      key={key}
      open={prompt !== null}
      accounts={accounts}
      prompt={shown}
      onDone={(r) => accounts.resolvePrompt(r)}
    />
  );
}

type View = 'form' | 'forgot' | 'verify' | 'reset-sent';
type Mode = 'login' | 'signup';

interface DialogProps {
  open: boolean;
  accounts: NetworkAccounts;
  prompt: SignInPrompt;
  onDone: (r: 'signed-in' | 'guest' | 'cancel') => void;
}

export function NetworkSignInDialog({ open, accounts, prompt, onDone }: DialogProps) {
  const { link, reason } = prompt;
  const authHost = hostOf(link.authUrl);
  const [cfg, setCfg] = useState<AuthConfig | null>(null);
  const [cfgError, setCfgError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    accounts.config(link.authUrl).then((c) => { if (live) setCfg(c); }, (err) => { if (live) setCfgError(describeAuthError(err)); });
    return () => { live = false; };
  }, [accounts, link.authUrl]);

  // The network's branding (logo, login background), looked up again now.
  useEffect(() => { void getNetworkThemes().refresh(link.host); }, [link.host]);
  const brand = useNetworkBranding(link.host);

  const name = (cfg?.site_name || cfg?.network_name || '').trim() || accounts.nameFor(link.authUrl, prompt.serverName);
  const guestOk = prompt.allowGuest && guestAccessAllowed(cfg);
  const registration = cfg?.registration ?? 'open';
  const canSignUp = registration !== 'closed';

  if (link.main) {
    // The app's own network while in guest mode: its account is the
    // boson.chat one, signed in to from the main sign-in screen.
    return (
      <Modal open={open} onClose={() => onDone('cancel')} title={`Sign in to ${name}`}>
        <div class="netauth">
          <NetworkBrandHero brand={brand} name={name} />
          <Realm host={authHost} main />
          {!guestOk && <p class="netauth-required" role="status">{name} requires an account. Guests can't connect.</p>}
          <p class="netauth-lede">This network uses your boson.chat account. Signing in leaves guest mode on this device.</p>
          <div class="netauth-actions">
            <Button
              variant="primary"
              fullWidth
              onClick={() => { onDone('cancel'); clearGuestSession(); emitGuestChange(); }}
            >
              Sign in to boson.chat
            </Button>
            {guestOk && <Button variant="ghost" fullWidth onClick={() => onDone('guest')}>Continue as guest</Button>}
          </div>
        </div>
      </Modal>
    );
  }

  return (
    <Modal open={open} onClose={() => onDone('cancel')} title={`Sign in to ${name}`}>
      <NetworkBrandHero brand={brand} name={name} />
      <NetworkSignInForm
        auth={accounts.service(link.authUrl)}
        authHost={authHost}
        name={name}
        cfg={cfg}
        cfgError={cfgError}
        reason={reason}
        guestOk={guestOk}
        canSignUp={canSignUp}
        inviteOnly={registration === 'invite'}
        onDone={onDone}
      />
    </Modal>
  );
}

// Which server the user is giving their password to: the network's own
// sign-in service, not boson.chat.
export function Realm({ host, main = false }: { host: string; main?: boolean }) {
  return (
    <div class="netauth-realm">
      <span class="netauth-realm-prompt" aria-hidden="true">$</span>
      <span class="netauth-realm-text">
        {main ? 'boson.chat account' : 'account on'} <span class="netauth-realm-host">{host}</span>
      </span>
    </div>
  );
}

const REASON_TEXT: Record<SignInPrompt['reason'], (name: string) => string | null> = {
  connect: () => null,
  manage: () => null,
  required: (name) => `${name} requires an account. Sign in or create one to connect.`,
  expired: (name) => `${name} didn't accept your sign-in. Sign in again to connect with your account.`,
};

// The sign-in / sign-up / SSO form for a network's own auth service. Also
// the login screen's "Use another server" step (LoginScreen/OtherServer).
export function NetworkSignInForm({ auth, authHost, name, cfg, cfgError, reason, guestOk, canSignUp, inviteOnly, onDone, guestLabel = 'Continue as guest' }: {
  auth: AuthService;
  authHost: string;
  name: string;
  cfg: AuthConfig | null;
  cfgError: string | null;
  reason: SignInPrompt['reason'];
  guestOk: boolean;
  canSignUp: boolean;
  inviteOnly: boolean;
  onDone: (r: 'signed-in' | 'guest' | 'cancel') => void;
  guestLabel?: string;
}) {
  const [view, setView] = useState<View>('form');
  const [mode, setMode] = useState<Mode>('login');
  const [login, setLogin] = useState('');
  const [username, setUsername] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [invite, setInvite] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [ssoPending, setSsoPending] = useState<SSOProvider | null>(null);
  const flow = useRef<{ cancel(): void } | null>(null);
  useEffect(() => () => flow.current?.cancel(), []);
  const sso = ssoBridge();
  const providers = sso ? cfg?.sso_providers ?? [] : [];
  const reasonText = REASON_TEXT[reason](name);
  const usernameProblem = mode === 'signup' && username ? validateUsername(username) : null;

  const done = (): void => onDone('signed-in');

  const run = async (fn: () => Promise<void>): Promise<void> => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await fn();
    } catch (err) {
      if (err instanceof AuthError && err.code === 'email_not_verified') {
        setView('verify');
      } else {
        setError(describeAuthError(err));
      }
    } finally {
      setBusy(false);
    }
  };

  const signIn = (e: Event): void => {
    e.preventDefault();
    void run(async () => { await auth.signIn(login, password); done(); });
  };

  const signUp = (e: Event): void => {
    e.preventDefault();
    if (usernameProblem) { setError(usernameProblem); return; }
    void run(async () => {
      const r = await auth.signUp({ username, email, password, ...(inviteOnly ? { invite_code: invite } : {}) });
      if (r.verificationRequired) {
        setLogin(username);
        setView('verify');
        return;
      }
      done();
    });
  };

  const withProvider = (p: SSOProvider): void => {
    if (!sso) return;
    setError(null);
    setSsoPending(p);
    const f = signInWithProvider(auth, sso, p);
    flow.current = f;
    f.done.then(() => { flow.current = null; setSsoPending(null); done(); }, (err) => {
      if (flow.current !== f) return;
      flow.current = null;
      setSsoPending(null);
      if (!(err instanceof AuthError && err.code === SSO_CANCELLED)) setError(describeAuthError(err));
    });
  };

  if (view === 'verify') {
    return (
      <div class="netauth">
        <Realm host={authHost} />
        <div class="netauth-panel">
          <h3 class="netauth-panel-title">Check your email.</h3>
          <p class="netauth-lede">
            {email ? <>{name} sent a verification link to <strong class="netauth-strong">{email}</strong>. </> : <>Your email address on {name} isn't verified yet. </>}
            Open the link, then come back and continue.
          </p>
          {!email && (
            <Field label="Email" hint="To send the link again.">
              <Input aria-label="Email" placeholder="email" type="email" value={email} onInput={(e) => setEmail((e.target as HTMLInputElement).value)} autoComplete="email" />
            </Field>
          )}
          {notice && <div class="login-notice" role="status">{notice}</div>}
          {error && <div class="login-error" role="alert">{error}</div>}
          <div class="netauth-actions">
            <Button
              variant="primary"
              fullWidth
              loading={busy}
              disabled={busy}
              onClick={() => { void run(async () => { await auth.signIn(login || email, password); done(); }); }}
            >
              Continue
            </Button>
            <div class="netauth-row">
              <Button variant="ghost" size="sm" disabled={busy} onClick={() => { setView('form'); setError(null); }}>Back</Button>
              <Button
                variant="ghost"
                size="sm"
                disabled={busy || !email.trim()}
                onClick={() => { void run(async () => { await auth.resendVerification(email); setNotice('Sent. Check your inbox (and spam).'); }); }}
              >
                Resend email
              </Button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (view === 'forgot' || view === 'reset-sent') {
    return (
      <div class="netauth">
        <Realm host={authHost} />
        <form
          class="netauth-panel"
          onSubmit={(e) => {
            e.preventDefault();
            void run(async () => { await auth.requestPasswordReset(email); setView('reset-sent'); });
          }}
        >
          <h3 class="netauth-panel-title">Reset your {name} password</h3>
          {view === 'reset-sent' ? (
            <div class="login-notice" role="status">
              If {email.trim()} has an account on {name}, a reset link is on its way. Set a new password from the email, then sign in here.
            </div>
          ) : (
            <Field label="Email" hint={`${name} emails you a link to set a new password.`}>
              <Input aria-label="Email" placeholder="email"
                type="email"
                value={email}
                onInput={(e) => setEmail((e.target as HTMLInputElement).value)}
                autoFocus
                required
                autoComplete="email"
              />
            </Field>
          )}
          {error && <div class="login-error" role="alert">{error}</div>}
          <div class="netauth-actions">
            {view === 'forgot' && <Button type="submit" variant="primary" fullWidth loading={busy} disabled={busy}>Send reset link</Button>}
            <Button variant="ghost" fullWidth disabled={busy} onClick={() => { setView('form'); setError(null); }}>Back to sign in</Button>
          </div>
        </form>
      </div>
    );
  }

  return (
    <div class="netauth">
      <Realm host={authHost} />
      {reasonText && <p class="netauth-required" role="status">{reasonText}</p>}
      {cfgError && <div class="login-error" role="alert">Couldn't reach {name}'s sign-in service: {cfgError}</div>}

      {canSignUp && (
        <Tabs
          tabs={[{ id: 'login', label: 'Sign in' }, { id: 'signup', label: 'Create account' }]}
          active={mode}
          onChange={(id) => { setMode(id as Mode); setError(null); }}
        />
      )}

      <form class="netauth-form" onSubmit={mode === 'login' ? signIn : signUp}>
        {mode === 'login' ? (
          <Field label="Username or email">
            <Input aria-label="Username or email" placeholder="username or email"
              value={login}
              onInput={(e) => setLogin((e.target as HTMLInputElement).value)}
              autoFocus
              required
              autoComplete="username"
              spellcheck={false}
            />
          </Field>
        ) : (
          <>
            <Field label="Username" hint={`Your account name on ${name}, and your nick on its IRC.`} error={usernameProblem ?? undefined}>
              <Input aria-label="Username" placeholder="username"
                value={username}
                onInput={(e) => setUsername((e.target as HTMLInputElement).value)}
                autoFocus
                required
                autoComplete="username"
                spellcheck={false}
              />
            </Field>
            <Field label="Email">
              <Input aria-label="Email" placeholder="email" type="email" value={email} onInput={(e) => setEmail((e.target as HTMLInputElement).value)} required autoComplete="email" />
            </Field>
            {inviteOnly && (
              <Field label="Invite code" hint={`${name} takes new accounts by invite. Ask its admins for a code.`}>
                <Input aria-label="Invite code" placeholder="invite code" value={invite} onInput={(e) => setInvite((e.target as HTMLInputElement).value)} required autoComplete="off" spellcheck={false} />
              </Field>
            )}
          </>
        )}
        <Field label="Password">
          <Input aria-label="Password" placeholder="password"
            type="password"
            value={password}
            onInput={(e) => setPassword((e.target as HTMLInputElement).value)}
            required
            autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
          />
        </Field>
        {mode === 'signup' && cfg?.require_email_verification && (
          <p class="netauth-hint">{name} emails you a link to verify your address before you can sign in.</p>
        )}
        {error && <div class="login-error" role="alert">{error}</div>}
        <div class="netauth-actions">
          <Button type="submit" variant="primary" fullWidth loading={busy && !ssoPending} disabled={busy || !!ssoPending}>
            {mode === 'login' ? 'Sign in' : 'Create account'}
          </Button>
          {mode === 'login' && (
            <Button variant="ghost" size="sm" class="login-forgot" onClick={() => { setView('forgot'); setError(null); setEmail(login.includes('@') ? login : email); }}>
              Forgot password?
            </Button>
          )}
          {!canSignUp && cfg && <p class="netauth-hint">{name} isn't taking new accounts right now.</p>}
        </div>
      </form>

      {providers.length > 0 && (
        <div class="login-sso" aria-label={`Sign in to ${name} with another account`}>
          <div class="login-sso-divider" aria-hidden="true"><span>or</span></div>
          {ssoPending ? (
            <div class="login-sso-waiting" role="status">
              <span class="login-sso-spinner" aria-hidden="true" />
              <span>Finish signing in with {ssoPending.display_name || ssoPending.slug} in your browser.</span>
              <Button variant="ghost" size="sm" onClick={() => { flow.current?.cancel(); }}>Cancel</Button>
            </div>
          ) : providers.map((p) => (
            <Button key={p.slug} variant="secondary" fullWidth disabled={busy} onClick={() => withProvider(p)}>
              Sign in with {p.display_name || p.slug}
            </Button>
          ))}
        </div>
      )}

      <div class="netauth-foot">
        {guestOk ? (
          <>
            <span class="netauth-foot-text">No account? You can still chat on {name}'s IRC.</span>
            <Button variant="ghost" size="sm" onClick={() => onDone('guest')}>{guestLabel}</Button>
          </>
        ) : reason !== 'expired' && cfg && !guestAccessAllowed(cfg) ? (
          <span class="netauth-foot-text">{name} requires an account: guests can't connect.</span>
        ) : (
          <span class="netauth-foot-text">An account on {name} is separate from a boson.chat account.</span>
        )}
      </div>
    </div>
  );
}
