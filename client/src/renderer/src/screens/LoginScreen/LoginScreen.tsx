import { useEffect, useMemo, useState } from 'preact/hooks';
import { guestAccessAllowed, useAuthService, useAuthState } from '../../modules/auth';
import type { DirectoryService } from '../../modules/directory';
import type { IdentityService } from '../../modules/identity';
import { Button, Card, Field, Input, Logo, Tabs, WarningBanner } from '@boson/shared';
import { LoginBloc, type LoginMode } from './LoginBloc';
import { emitGuestChange, saveGuestSession } from '../../modules/guest/guest';
import { sanitizeIrcNick } from '../../modules/identity/nick';
import { getNetworkAccounts, type NetworkAccounts } from '../../modules/netauth/network-accounts';
import { clearLastServer, enterWithServer, loadLastServer, type LastServer } from '../../modules/netauth/other-server';
import { OtherServer } from './OtherServer';
import { MAIN_NETWORK_KEY, useNetworkThemes } from '../../modules/ui/theme';
import { NetworkLoginLogo, loginBackdrop } from '../NetworkSignIn/NetworkBrand';
import './LoginScreen.css';

interface Props {
  directory: DirectoryService;
  identity: IdentityService;
  // Self-hosted networks' accounts ("Use another server"); the app's by
  // default. null: this app can't sign in to other networks.
  accounts?: NetworkAccounts | null;
}

export function LoginScreen({ directory, identity, accounts = getNetworkAccounts() }: Props) {
  const auth = useAuthService();
  const bloc = useMemo(() => new LoginBloc({ auth, directory, identity }), [auth, directory, identity]);
  const [state, setState] = useState(() => bloc.getState());
  useEffect(() => bloc.subscribe(setState), [bloc]);

  const {
    mode, login, username, email, password, confirmPassword, error, unrecoverable, recoverable, busy,
    awaitingConfirmation, forgotOpen, notice, ssoProviders, ssoPending, identityPrompt,
  } = state;
  const { session } = useAuthState();
  useEffect(() => { void bloc.loadProviders(); }, [bloc]);
  useEffect(() => () => bloc.cancelSignInWith(), [bloc]);
  const usernameProblem = bloc.usernameProblem();
  const [recoveryInput, setRecoveryInput] = useState('');

  // Guest-mode local state. The user clicks "Continue as guest" to reveal a
  // single nick field; submitting it writes a localStorage record and emits
  // an event that the App router picks up to swap into the directory.
  const [guestPrompt, setGuestPrompt] = useState(false);
  const [guestNick, setGuestNick] = useState('');
  // boson.chat's own IRC may take no guests (guest_access: false). Guest
  // mode still reaches other networks, so it stays; it just says so.
  const [mainGuestOk, setMainGuestOk] = useState(true);
  useEffect(() => {
    if (typeof auth.config !== 'function') return;
    let live = true;
    auth.config().then((c) => { if (live) setMainGuestOk(guestAccessAllowed(c)); }, () => {});
    return () => { live = false; };
  }, [auth]);

  // "Use another server": a self-hosted network instead of boson.chat.
  const [other, setOther] = useState(false);
  const [otherAddress, setOtherAddress] = useState<string | null>(null);
  const resume = useLastServer(accounts);

  // The network's branding (network themes): under "Use another server",
  // the network's once it's found (its IRC host); otherwise boson.chat's
  // own, when its auth service publishes one (/v1/config branding_url).
  const [otherHost, setOtherHost] = useState<string | null>(null);
  const themes = useNetworkThemes();
  useEffect(() => {
    if (typeof auth.config === 'function') void themes.refreshMain(() => auth.config());
  }, [auth, themes]);
  useEffect(() => { if (otherHost) void themes.refresh(otherHost); }, [otherHost, themes]);
  const brandKey = other ? otherHost : MAIN_NETWORK_KEY;
  const brand = brandKey ? themes.brandingFor(brandKey) : null;
  const brandName = other ? (otherAddress ?? '') : 'boson.chat';
  const backdrop = loginBackdrop(brand);
  const logo = brand?.applied && (brand.logo || brand.logoWide)
    ? <NetworkLoginLogo brand={brand} name={brandName} />
    : <Logo />;

  const onSubmit = (kind: 'signin' | 'signup', e: Event) => {
    e.preventDefault();
    void (kind === 'signin' ? bloc.signIn() : bloc.signUp());
  };

  const submitGuest = (e: Event): void => {
    e.preventDefault();
    const nick = sanitizeIrcNick(guestNick.trim());
    if (!nick) return;
    saveGuestSession({ nick });
    emitGuestChange();
  };

  // After a sign-up (or a sign-in refused as unverified) the form gives way
  // to "Check your email": the link opens the auth service's page in the
  // browser; Continue then signs in with what was typed.
  if (awaitingConfirmation !== null) {
    return (
      <div {...backdrop}>
        <div class="login-container">
          {logo}
          <Card>
            <div class="login-confirm">
              <h2 class="login-confirm-title">Check your email.</h2>
              <p class="login-confirm-body">
                {awaitingConfirmation
                  ? <>We sent a verification link to <strong class="login-confirm-email">{awaitingConfirmation}</strong>. </>
                  : <>Your email address isn't verified yet. </>}
                Open it, then come back and continue.
              </p>
              {!awaitingConfirmation && (
                <Field label="Email" hint="To send the link again.">
                  <Input
                    type="email"
                    placeholder="email"
                    value={email}
                    onInput={(e) => bloc.setEmail((e.target as HTMLInputElement).value)}
                    autoComplete="email"
                  />
                </Field>
              )}
              {notice && <p class="login-confirm-hint" role="status">{notice}</p>}
              {error && <div class="login-error" role="alert">{error}</div>}
              <p class="login-confirm-hint">
                Email taking a while? Check spam, send it again, or go back
                to fix the address.
              </p>
              <Button type="button" variant="primary" fullWidth disabled={busy} loading={busy} onClick={() => { void bloc.continueAfterVerification(); }}>
                Continue
              </Button>
              <div class="login-confirm-actions">
                <Button type="button" variant="ghost" disabled={busy} onClick={() => bloc.cancelAwaitingConfirmation()}>
                  Back
                </Button>
                <Button type="button" variant="ghost" disabled={busy} onClick={() => { void bloc.resendVerification(); }}>
                  Resend email
                </Button>
              </div>
            </div>
          </Card>
        </div>
      </div>
    );
  }

  // Signed in through a provider; the identity key needs its passphrase
  // (or a new one) on this device.
  if (identityPrompt !== null) {
    const who = session?.user.username;
    const creating = identityPrompt === 'create';
    return (
      <div {...backdrop}>
        <div class="login-container">
          {logo}
          <Card>
            <form class="login-confirm" onSubmit={(e) => { e.preventDefault(); void bloc.submitIdentityPassphrase(); }}>
              <h2 class="login-confirm-title">{creating ? 'Set an identity passphrase.' : 'Unlock your identity key.'}</h2>
              <p class="login-confirm-body">
                {who && <>Signed in as <strong class="login-confirm-email">{who}</strong>. </>}
                {creating
                  ? 'Your identity key signs you in to IRC servers and encrypts the passwords Boson syncs. Pick a passphrase to protect it: you enter it once on each new device.'
                  : 'Your identity key is protected by your Boson password (or the passphrase you set). Enter it once on this device.'}
              </p>
              <Field label={creating ? 'Passphrase' : 'Password or passphrase'}>
                <Input
                  type="password"
                  placeholder={creating ? 'passphrase' : 'password'}
                  value={password}
                  onInput={(e) => bloc.setPassword((e.target as HTMLInputElement).value)}
                  autoFocus
                  required
                  autoComplete={creating ? 'new-password' : 'current-password'}
                />
              </Field>
              {creating && (
                <Field label="Confirm passphrase">
                  <Input
                    type="password"
                    placeholder="confirm passphrase"
                    value={confirmPassword}
                    onInput={(e) => bloc.setConfirmPassword((e.target as HTMLInputElement).value)}
                    required
                    autoComplete="new-password"
                  />
                </Field>
              )}
              {error && <div class="login-error" role="alert">{error}</div>}
              {recoverable && (
                <div class="login-recovery">
                  <Field label="Recovery code" hint="The one-time code shown when you created your account.">
                    <Input
                      placeholder="xxxx-xxxx-xxxx-xxxx-xxxx-xxxx-xxxx-xxxx"
                      value={recoveryInput}
                      onInput={(e) => setRecoveryInput((e.target as HTMLInputElement).value)}
                      autoComplete="off"
                      spellcheck={false}
                    />
                  </Field>
                  <Button
                    type="button"
                    variant="secondary"
                    fullWidth
                    disabled={busy || recoveryInput.trim().length === 0}
                    onClick={() => { void bloc.recoverWithCode(recoveryInput); }}
                  >
                    Recover with code
                  </Button>
                </div>
              )}
              <div class="login-actions">
                <Button type="submit" variant="primary" fullWidth disabled={busy || !password} loading={busy}>
                  {creating ? 'Create identity key' : 'Unlock'}
                </Button>
                <Button type="button" variant="ghost" fullWidth disabled={busy} onClick={() => { void bloc.abandonIdentityPrompt(); }}>
                  Sign out
                </Button>
              </div>
            </form>
          </Card>
        </div>
      </div>
    );
  }

  if (forgotOpen) {
    return (
      <div {...backdrop}>
        <div class="login-container">
          {logo}
          <Card>
            <form onSubmit={(e) => { e.preventDefault(); void bloc.sendPasswordReset(); }}>
              <Field label="Email" hint="We'll email you a link to set a new password.">
                <Input
                  type="email"
                  placeholder="email"
                  value={email}
                  onInput={(e) => bloc.setEmail((e.target as HTMLInputElement).value)}
                  autoFocus
                  required
                  autoComplete="email"
                />
              </Field>
              {error && <div class="login-error" role="alert">{error}</div>}
              <div class="login-actions">
                <Button type="submit" variant="primary" fullWidth disabled={busy} loading={busy}>
                  Send reset link
                </Button>
                <Button type="button" variant="ghost" fullWidth disabled={busy} onClick={() => bloc.closeForgot()}>
                  Back to sign in
                </Button>
              </div>
            </form>
          </Card>
        </div>
      </div>
    );
  }

  const serverLine = accounts?.supported ? (
    <div class="login-server">
      <span class="login-server-label">
        <span class="login-server-prompt" aria-hidden="true">$</span>
        <span>server</span>
        <span class="login-server-host">{other ? (otherAddress ?? '…') : 'boson.chat'}</span>
      </span>
      <button
        type="button"
        class="login-guest-toggle login-server-switch"
        onClick={() => { setOther(!other); setOtherAddress(null); setOtherHost(null); }}
      >
        {other ? 'Back to boson.chat' : 'Use another server'}
      </button>
    </div>
  ) : null;

  if (other) {
    return (
      <div {...backdrop}>
        <div class="login-container">
          {logo}
          {serverLine}
          <Card>
            <OtherServer
              accounts={accounts ?? null}
              initialAddress={resume.last?.address ?? ''}
              onBack={() => { setOther(false); setOtherAddress(null); setOtherHost(null); }}
              onAddress={setOtherAddress}
              onNetworkHost={setOtherHost}
            />
          </Card>
        </div>
      </div>
    );
  }

  return (
    <div {...backdrop}>
      <div class="login-container">
        {logo}

        {resume.last && resume.user && (
          <div class="login-resume">
            <Button
              type="button"
              variant="secondary"
              fullWidth
              onClick={() => enterWithServer({ accounts: accounts ?? null, server: resume.last!, nick: resume.user!, asGuest: false })}
            >
              Continue to {resume.last.name} as {resume.user}
            </Button>
            <button type="button" class="login-guest-toggle login-resume-forget" onClick={resume.forget}>
              Not you? Forget {resume.last.name}
            </button>
          </div>
        )}

        {serverLine}

        <Tabs
          tabs={[
            { id: 'login', label: 'Login' },
            { id: 'signup', label: 'Signup' },
          ]}
          active={mode}
          onChange={(id) => bloc.setMode(id as LoginMode)}
        />

        <Card>
          <form onSubmit={(e) => onSubmit(mode === 'signup' ? 'signup' : 'signin', e)}>
            {mode === 'login' ? (
              <Field label="Username or email">
                <Input
                  type="text"
                  placeholder="username or email"
                  value={login}
                  onInput={(e) => bloc.setLogin((e.target as HTMLInputElement).value)}
                  autoFocus
                  required
                  autoComplete="username"
                  spellcheck={false}
                />
              </Field>
            ) : (
              <>
                <Field
                  label="Username"
                  hint="Your account name, IRC-nick style: letters, digits and - [ ] \ ` _ ^ { | }, up to 30."
                  error={usernameProblem ?? undefined}
                >
                  <Input
                    type="text"
                    placeholder="username"
                    value={username}
                    onInput={(e) => bloc.setUsername((e.target as HTMLInputElement).value)}
                    autoFocus
                    required
                    autoComplete="username"
                    spellcheck={false}
                  />
                </Field>
                <Field label="Email">
                  <Input
                    type="email"
                    placeholder="email"
                    value={email}
                    onInput={(e) => bloc.setEmail((e.target as HTMLInputElement).value)}
                    required
                    autoComplete="email"
                  />
                </Field>
              </>
            )}

            <Field
              label="Password"
              hint={mode === 'login'
                ? 'This unlocks your identity key from the keychain.'
                : 'This encrypts your identity key. Lose it → lose access to all servers.'}
            >
              <Input
                type="password"
                placeholder="password"
                value={password}
                onInput={(e) => bloc.setPassword((e.target as HTMLInputElement).value)}
                required
                autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
              />
            </Field>

            {mode === 'signup' && (
              <Field label="Confirm password">
                <Input
                  type="password"
                  placeholder="confirm password"
                  value={confirmPassword}
                  onInput={(e) => bloc.setConfirmPassword((e.target as HTMLInputElement).value)}
                  required
                  autoComplete="new-password"
                />
              </Field>
            )}

            {error && (
              <div class="login-error" role="alert">
                {error}
                {unrecoverable && (
                  <div class="login-error-action">
                    <Button
                      type="button"
                      variant="primary"
                      disabled={busy}
                      loading={busy}
                      onClick={() => { void bloc.startFresh(); }}
                    >
                      Start fresh
                    </Button>
                  </div>
                )}
              </div>
            )}

            {notice && <div class="login-notice" role="status">{notice}</div>}

            {recoverable && (
              <div class="login-recovery">
                <Field label="Recovery code" hint="The one-time code shown when you created your account.">
                  <Input
                    placeholder="xxxx-xxxx-xxxx-xxxx-xxxx-xxxx-xxxx-xxxx"
                    value={recoveryInput}
                    onInput={(e) => setRecoveryInput((e.target as HTMLInputElement).value)}
                    autoComplete="off"
                    spellcheck={false}
                  />
                </Field>
                <Button
                  type="button"
                  variant="primary"
                  fullWidth
                  disabled={busy || recoveryInput.trim().length === 0}
                  loading={busy}
                  onClick={() => { void bloc.recoverWithCode(recoveryInput); }}
                >
                  Recover with code
                </Button>
              </div>
            )}

            <div class="login-actions">
              {/* The other mode's button switches tabs rather than submitting
                  (the forms ask for different fields). */}
              <Button
                type={mode === 'login' ? 'submit' : 'button'}
                variant={mode === 'login' ? 'primary' : 'ghost'}
                fullWidth
                disabled={busy}
                loading={busy && !ssoPending && mode === 'login'}
                onClick={(e) => { if (mode === 'login') onSubmit('signin', e); else { e.preventDefault(); bloc.setMode('login'); } }}
              >
                Sign in
              </Button>
              <Button
                type={mode === 'signup' ? 'submit' : 'button'}
                variant={mode === 'signup' ? 'primary' : 'ghost'}
                fullWidth
                disabled={busy}
                loading={busy && !ssoPending && mode === 'signup'}
                onClick={(e) => { if (mode === 'signup') onSubmit('signup', e); else { e.preventDefault(); bloc.setMode('signup'); } }}
              >
                Sign up
              </Button>
            </div>

            {mode === 'login' && (
              <button type="button" class="login-guest-toggle login-forgot" onClick={() => bloc.openForgot()}>
                Forgot password?
              </button>
            )}

            {ssoProviders.length > 0 && (
              <div class="login-sso" aria-label="Sign in with another account">
                <div class="login-sso-divider" aria-hidden="true"><span>or</span></div>
                {ssoPending ? (
                  <div class="login-sso-waiting" role="status">
                    <span class="login-sso-spinner" aria-hidden="true" />
                    <span>
                      Finish signing in with {ssoProviders.find((p) => p.slug === ssoPending)?.display_name ?? ssoPending} in your browser.
                    </span>
                    <Button type="button" variant="ghost" size="sm" onClick={() => bloc.cancelSignInWith()}>Cancel</Button>
                  </div>
                ) : (
                  ssoProviders.map((p) => (
                    <Button
                      key={p.slug}
                      type="button"
                      variant="secondary"
                      fullWidth
                      disabled={busy}
                      onClick={() => { void bloc.signInWith(p.slug); }}
                    >
                      Continue with {p.display_name || p.slug}
                    </Button>
                  ))
                )}
              </div>
            )}

            {mode === 'signup' && (
              <WarningBanner tone="warn" title="Keep your recovery code">
                Your identity key is encrypted with your password. A password reset gets you back into your account, but unlocking the key afterwards needs the recovery code you'll be shown next.
              </WarningBanner>
            )}
          </form>
        </Card>

        <div class="login-guest">
          {!guestPrompt ? (
            <button
              type="button"
              class="login-guest-toggle"
              onClick={() => setGuestPrompt(true)}
            >
              Continue without an account
            </button>
          ) : null}
          {!guestPrompt && !mainGuestOk ? (
            <p class="login-guest-note">boson.chat requires an account to chat. Without one you can still use other networks.</p>
          ) : null}
          {guestPrompt && (
            <form onSubmit={submitGuest} class="login-guest-form">
              <Field
                label="Pick a nick"
                hint="Used as your IRC nickname. No account; data stays on this device."
              >
                <Input
                  placeholder="your-nick"
                  value={guestNick}
                  onInput={(e) => setGuestNick((e.target as HTMLInputElement).value)}
                  autoFocus
                  required
                  autoComplete="off"
                  spellcheck={false}
                />
              </Field>
              <div class="login-guest-actions">
                <Button type="button" variant="ghost" onClick={() => setGuestPrompt(false)}>Back</Button>
                <Button type="submit" variant="primary" disabled={!guestNick.trim()}>
                  Continue
                </Button>
              </div>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}

// The server last used from "Use another server", and the username its
// session (when still signed in) belongs to: the "Continue to <network> as
// <user>" shortcut.
function useLastServer(accounts: NetworkAccounts | null | undefined): {
  last: LastServer | null;
  user: string | null;
  forget: () => void;
} {
  const [last, setLast] = useState<LastServer | null>(() => (accounts?.supported ? loadLastServer() : null));
  const [user, setUser] = useState<string | null>(null);
  useEffect(() => {
    if (!accounts || !last?.authUrl) return;
    let live = true;
    const check = (): void => {
      const link = accounts.linkFor(last.irc.host);
      const session = link && !link.main ? accounts.sessionFor(link) : null;
      if (live) setUser(session?.user.username || null);
    };
    // Discovery lets the proxy reach the network's auth again and restores
    // its saved session (refreshing it if needed).
    void accounts.discover(last.irc.host).then(check, () => {});
    const off = accounts.subscribe(check);
    return () => { live = false; off(); };
  }, [accounts, last]);
  return {
    last,
    user,
    forget: () => { clearLastServer(); setLast(null); setUser(null); },
  };
}
