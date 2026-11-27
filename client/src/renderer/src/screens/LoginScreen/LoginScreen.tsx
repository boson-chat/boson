import { useEffect, useMemo, useState } from 'preact/hooks';
import { guestAccessAllowed, useAuthService, useAuthState } from '../../modules/auth';
import type { DirectoryService } from '../../modules/directory';
import type { IdentityService } from '../../modules/identity';
import { Button, Card, Field, Input, Logo, Tabs } from '@boson/shared';
import { PASSWORD_MIN } from '../../modules/auth/signup-rules';
import { LoginBloc, type LoginMode } from './LoginBloc';
import { emitGuestChange, saveGuestSession } from '../../modules/guest/guest';
import { sanitizeIrcNick } from '../../modules/identity/nick';
import { getNetworkAccounts, type NetworkAccounts } from '../../modules/netauth/network-accounts';
import { clearLastServer, enterWithServer, loadLastServer, type LastServer } from '../../modules/netauth/other-server';
import { OtherServer } from './OtherServer';
import { useHomeNetwork } from '../../modules/netauth/home-network';
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
  // The app's own network: boson.chat, or the self-hosted network whose
  // web client this is (home-network.ts).
  const home = useHomeNetwork();
  const bloc = useMemo(() => new LoginBloc({ auth, directory, identity }), [auth, directory, identity]);
  const [state, setState] = useState(() => bloc.getState());
  useEffect(() => bloc.subscribe(setState), [bloc]);

  const {
    mode, login, username, email, password, confirmPassword, error, unrecoverable, recoverable, busy,
    awaitingConfirmation, forgotOpen, notice, ssoProviders, ssoPending, identityPrompt, fieldErrors,
  } = state;
  const { session, signedOutReason } = useAuthState();
  useEffect(() => { void bloc.loadProviders(); }, [bloc]);
  useEffect(() => () => bloc.cancelSignInWith(), [bloc]);
  const usernameProblem = bloc.usernameProblem();
  const [recoveryInput, setRecoveryInput] = useState('');

  // Guest mode: "Continue without an account" swaps the sign-in form for
  // its own step (a name, what's kept, Back); submitting it writes a
  // localStorage record and emits an event that the App router picks up to
  // swap into the directory.
  const [guestPrompt, setGuestPrompt] = useState(false);
  const [guestNick, setGuestNick] = useState('');
  // The home network's own IRC may take no guests (guest_access: false). Guest
  // mode still reaches other networks, so it stays; it just says so.
  const [mainGuestOk, setMainGuestOk] = useState(true);
  useEffect(() => {
    if (typeof auth.config !== 'function') return;
    let live = true;
    auth.config().then((c) => { if (live) setMainGuestOk(guestAccessAllowed(c)); }, () => {});
    return () => { live = false; };
  }, [auth]);

  // "Use another server": another network instead of the app's own.
  const [other, setOther] = useState(false);
  const [otherAddress, setOtherAddress] = useState<string | null>(null);
  const resume = useLastServer(accounts);

  // The network's branding (network themes): under "Use another server",
  // the network's once it's found (its IRC host); otherwise the home
  // network's own, when its auth service publishes one (/v1/config branding_url).
  const [otherHost, setOtherHost] = useState<string | null>(null);
  const themes = useNetworkThemes();
  useEffect(() => {
    if (typeof auth.config === 'function') void themes.refreshMain(() => auth.config());
  }, [auth, themes]);
  useEffect(() => { if (otherHost) void themes.refresh(otherHost); }, [otherHost, themes]);
  const brandKey = other ? otherHost : MAIN_NETWORK_KEY;
  const brand = brandKey ? themes.brandingFor(brandKey) : null;
  const brandName = other ? (otherAddress ?? '') : home.name;
  const backdrop = loginBackdrop(brand);
  const logo = brand?.applied && (brand.logo || brand.logoWide)
    ? <NetworkLoginLogo brand={brand} name={brandName} />
    : (
      <div class="login-hero">
        <Logo tagline="" />
        <p class="login-pitch">Chat, voice and video with your communities, in one app.</p>
      </div>
    );

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

  // Waiting on the emailed link: when the user comes back to the app (after
  // opening it in the browser), try signing in by itself.
  const awaiting = awaitingConfirmation !== null;
  useEffect(() => {
    if (!awaiting) return;
    const retry = (): void => {
      if (document.visibilityState === 'visible') void bloc.retryAfterVerification();
    };
    window.addEventListener('focus', retry);
    document.addEventListener('visibilitychange', retry);
    return () => {
      window.removeEventListener('focus', retry);
      document.removeEventListener('visibilitychange', retry);
    };
  }, [awaiting, bloc]);

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
                Open it, then come back here: you'll be signed in.
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

  // Which server the form signs in to: a quiet line with a "Change" link
  // (another network instead of the app's own).
  const serverLine = accounts?.supported ? (
    <div class="login-server">
      <span class="login-server-label">
        <span>{other ? 'Server' : 'Signing in to'}</span>
        <span class="login-server-host">{other ? (otherAddress ?? '…') : home.domain}</span>
      </span>
      <Button
        variant="ghost"
        size="sm"
        class="login-server-switch"
        aria-label={other ? undefined : 'Change: use another server'}
        onClick={() => { setOther(!other); setOtherAddress(null); setOtherHost(null); }}
      >
        {other ? `Back to ${home.name}` : 'Change'}
      </Button>
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

  // "Continue without an account": its own step in place of the form.
  if (guestPrompt) {
    return (
      <div {...backdrop}>
        <div class="login-container">
          {logo}
          <Card>
            <form onSubmit={submitGuest} class="login-guest-form">
              <h2 class="login-step-title">Continue as a guest</h2>
              <Field
                label="Display name"
                hint="What people see you as in chat. Letters, digits and - _ work best."
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
              <p class="login-guest-note">
                No account: your servers, settings and history stay on this device only.
                {!mainGuestOk && ` ${home.name} itself needs an account; other networks work as a guest.`}
              </p>
              <div class="login-actions">
                <Button type="submit" variant="primary" fullWidth disabled={!guestNick.trim()}>
                  Continue
                </Button>
                <Button type="button" variant="ghost" fullWidth onClick={() => setGuestPrompt(false)}>
                  Back
                </Button>
              </div>
            </form>
          </Card>
        </div>
      </div>
    );
  }

  const signup = mode === 'signup';
  const usernameError = fieldErrors.username ?? usernameProblem ?? undefined;

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
            <Button variant="ghost" size="sm" class="login-resume-forget" onClick={resume.forget}>
              Not you? Forget {resume.last.name}
            </Button>
          </div>
        )}

        <Tabs
          tabs={[
            { id: 'login', label: 'Login' },
            { id: 'signup', label: 'Signup' },
          ]}
          active={mode}
          onChange={(id) => bloc.setMode(id as LoginMode)}
        />

        <Card>
          <form noValidate={signup} onSubmit={(e) => onSubmit(signup ? 'signup' : 'signin', e)}>
            {signedOutReason === 'expired' && !signup && !error && (
              <div class="login-notice" role="status">
                You were signed out: your session ended or was signed out on another device. Sign in again to continue.
              </div>
            )}

            {!signup ? (
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
                  hint="Your name on Boson and in chat. Up to 30 letters, digits, - or _, starting with a letter."
                  error={usernameError}
                >
                  <Input
                    type="text"
                    placeholder="username"
                    value={username}
                    onInput={(e) => bloc.setUsername((e.target as HTMLInputElement).value)}
                    onBlur={() => bloc.blurField('username')}
                    invalid={!!usernameError}
                    autoFocus
                    required
                    autoComplete="username"
                    spellcheck={false}
                  />
                </Field>
                <Field label="Email" hint="For verifying your account and resetting your password." error={fieldErrors.email}>
                  <Input
                    type="email"
                    placeholder="email"
                    value={email}
                    onInput={(e) => bloc.setEmail((e.target as HTMLInputElement).value)}
                    onBlur={() => bloc.blurField('email')}
                    invalid={!!fieldErrors.email}
                    required
                    autoComplete="email"
                  />
                </Field>
              </>
            )}

            <Field
              label="Password"
              hint={signup ? `At least ${PASSWORD_MIN} characters.` : undefined}
              error={signup ? fieldErrors.password : undefined}
            >
              <Input
                type="password"
                placeholder="password"
                value={password}
                onInput={(e) => bloc.setPassword((e.target as HTMLInputElement).value)}
                onBlur={() => bloc.blurField('password')}
                invalid={signup && !!fieldErrors.password}
                required
                autoComplete={signup ? 'new-password' : 'current-password'}
              />
            </Field>

            {signup && (
              <Field label="Confirm password" error={fieldErrors.confirmPassword}>
                <Input
                  type="password"
                  placeholder="confirm password"
                  value={confirmPassword}
                  onInput={(e) => bloc.setConfirmPassword((e.target as HTMLInputElement).value)}
                  onBlur={() => bloc.blurField('confirmPassword')}
                  invalid={!!fieldErrors.confirmPassword}
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
              {/* Only the active tab's action; the tabs switch modes. */}
              <Button
                type="submit"
                variant="primary"
                fullWidth
                disabled={busy}
                loading={busy && !ssoPending}
              >
                {signup ? 'Sign up' : 'Sign in'}
              </Button>
            </div>

            {!signup && (
              <Button variant="ghost" size="sm" class="login-forgot" onClick={() => bloc.openForgot()}>
                Forgot password?
              </Button>
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
          </form>
        </Card>

        {serverLine}

        <div class="login-guest">
          <Button
            variant="ghost"
            class="login-guest-toggle"
            onClick={() => setGuestPrompt(true)}
          >
            Continue without an account
          </Button>
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
