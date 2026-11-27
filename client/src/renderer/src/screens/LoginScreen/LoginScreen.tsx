import { useEffect, useMemo, useState } from 'preact/hooks';
import { ChevronRight } from 'lucide-preact';
import { closedSignupLine, guestAccessAllowed, signupMode, useAuthService, useAuthState, type AuthConfig } from '../../modules/auth';
import type { DirectoryService } from '../../modules/directory';
import type { IdentityService } from '../../modules/identity';
import { Button, Card, Field, Input, Logo, Tabs } from '@boson/shared';
import { PASSWORD_MIN } from '../../modules/auth/signup-rules';
import { LoginBloc, type LoginMode } from './LoginBloc';
import { takeResumeIdentity } from '../../modules/auth/resume-identity';
import { emitGuestChange, saveGuestSession } from '../../modules/guest/guest';
import { sanitizeIrcNick } from '../../modules/identity/nick';
import { getNetworkAccounts, normalizeAuthBase, type NetworkAccounts, type NetworkLink } from '../../modules/netauth/network-accounts';
import {
  clearLastServer, enterWithServer, loadLastServer, type LastServer,
} from '../../modules/netauth/other-server';
import { acceptsFederation, type HomeAccount } from '../../modules/netauth/federation';
import { OtherServer } from './OtherServer';
import { BOSON_CHAT_HOME, useHomeNetwork, type HomeNetwork } from '../../modules/netauth/home-network';
import { FederatedSignIn } from '../NetworkSignIn/FederatedSignIn';
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
  // Signed in already, identity key locked: one of this server's own
  // accounts that just became the app's own (home-session.ts) goes
  // straight to the key. A federated session never shows this screen.
  useEffect(() => {
    const resume = takeResumeIdentity();
    if (session && resume) void bloc.resumeSignedIn();
    // Once, on mount.
  }, [bloc]);
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
  // The home network's public settings: its sign-up (open, invite-only or
  // closed). Until they're in, the Signup tab waits, so a closed network
  // doesn't flash one.
  const [mainCfg, setMainCfg] = useState<AuthConfig | null>(null);
  const [cfgSettled, setCfgSettled] = useState(() => typeof auth.config !== 'function');
  useEffect(() => {
    if (typeof auth.config !== 'function') return;
    let live = true;
    auth.config().then((c) => {
      if (!live) return;
      setMainGuestOk(guestAccessAllowed(c));
      setMainCfg(c);
      setCfgSettled(true);
    }, () => { if (live) setCfgSettled(true); });
    return () => { live = false; };
  }, [auth]);
  const signupKind = signupMode(mainCfg);
  const canSignUp = cfgSettled && signupKind !== 'closed';
  useEffect(() => { bloc.setInviteRequired(signupKind === 'invite'); }, [bloc, signupKind]);
  useEffect(() => { if (!canSignUp && cfgSettled && mode === 'signup') bloc.setMode('login'); }, [bloc, canSignUp, cfgSettled, mode]);

  // Federated sign-in to the home network (a self-hosted web client's
  // network that takes accounts from other Boson servers): "Continue as
  // alice@boson.chat" for accounts already signed in here, or "Continue
  // with boson.chat" to sign in there first and come back.
  const fed = useHomeFederation(accounts, home);
  const [comeBack, setComeBack] = useState(false);
  const [autoStart, setAutoStart] = useState<string | null>(null);
  const [fedNote, setFedNote] = useState<string | null>(null);

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
  // Its colours too, while its sign-in is on screen (as the chat applies
  // the active server's): the user's own theme, and Boson's defaults, come
  // back when it goes. The switches (Appearance → "Use network themes",
  // per network) and the app's dark / light mode apply as in the chat.
  useEffect(() => { themes.setActive(brandKey); }, [themes, brandKey]);
  useEffect(() => () => themes.setActive(null), [themes]);
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

  // Signed in at boson.chat to come back: the home network's "Continue
  // as …" for that account, started at once.
  const backFromHome = async (signedIn: NetworkLink): Promise<void> => {
    setOther(false); setOtherAddress(null); setOtherHost(null); setComeBack(false);
    setFedNote(null);
    if (!accounts || !fed.link) return;
    const homes = await accounts.homeAccounts(fed.link).catch(() => [] as HomeAccount[]);
    const h = homes.find((x) => normalizeAuthBase(x.authUrl) === normalizeAuthBase(signedIn.authUrl));
    if (h) setAutoStart(h.identity);
    else setFedNote(`You're signed in to ${BOSON_CHAT_HOME.domain}, but it can't sign you in to ${home.name}.`);
  };

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
        onClick={() => { setOther(!other); setOtherAddress(null); setOtherHost(null); setComeBack(false); }}
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
              initialAddress={comeBack ? BOSON_CHAT_HOME.domain : resume.last?.address ?? ''}
              autoLookUp={comeBack}
              onBack={() => { setOther(false); setOtherAddress(null); setOtherHost(null); setComeBack(false); }}
              onAddress={setOtherAddress}
              onNetworkHost={setOtherHost}
              {...(comeBack ? {
                comeBack: {
                  lede: `Sign in to ${BOSON_CHAT_HOME.domain}, or create an account there. Then you'll come back to ${home.name} with it: no password is shared.`,
                  onSignedIn: (link: NetworkLink) => { void backFromHome(link); },
                },
              } : {})}
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

  const signup = mode === 'signup' && canSignUp;
  // "Continue with boson.chat" (sign in there first): while sign-up is
  // closed, the network takes accounts from elsewhere, no boson.chat
  // account is signed in here yet, and this app can look boson.chat up.
  const offerBosonChat = !!fed.link && !canSignUp && cfgSettled && !!accounts?.canResolve
    && home.domain !== BOSON_CHAT_HOME.domain && !fed.homes.some((h) => h.domain === BOSON_CHAT_HOME.domain);
  const fedOffered = !fed.link ? null
    : offerBosonChat ? `your ${BOSON_CHAT_HOME.domain} account`
      : fed.homes.length === 1 ? `your ${fed.homes[0]!.domain} account`
        : fed.homes.length > 1 ? 'an account you already have' : null;
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

        {canSignUp ? (
          <Tabs
            tabs={[
              { id: 'login', label: 'Login' },
              { id: 'signup', label: 'Signup' },
            ]}
            active={mode}
            onChange={(id) => bloc.setMode(id as LoginMode)}
          />
        ) : cfgSettled && signupKind === 'closed' ? (
          <p class="login-closed" role="status">
            {closedSignupLine({ name: home.name, federated: fedOffered, guests: mainGuestOk })}
          </p>
        ) : null}

        <Card>
          {!signup && fed.link && accounts && (
            <HomeFederation
              accounts={accounts}
              link={fed.link}
              homes={fed.homes}
              home={home}
              signIn={(h) => bloc.continueFederated(() => accounts.signInFederated(fed.link!, h))}
              offerBosonChat={offerBosonChat}
              autoStart={autoStart}
              note={fedNote}
              onBosonChat={() => { setFedNote(null); setOther(true); setOtherAddress(null); setOtherHost(null); setComeBack(true); }}
            />
          )}
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
                {state.inviteRequired && (
                  <Field
                    label="Invite code"
                    hint={`${home.name} takes new accounts by invite. Ask its admins for a code.`}
                    error={fieldErrors.inviteCode}
                  >
                    <Input
                      type="text"
                      placeholder="invite code"
                      value={state.inviteCode}
                      onInput={(e) => bloc.setInviteCode((e.target as HTMLInputElement).value)}
                      onBlur={() => bloc.blurField('inviteCode')}
                      invalid={!!fieldErrors.inviteCode}
                      autoFocus
                      required
                      autoComplete="off"
                      spellcheck={false}
                    />
                  </Field>
                )}
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
                    autoFocus={!state.inviteRequired}
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

// The home network as a remote for federated sign-in: its link (with the
// boson.json federation block) when it takes accounts from other Boson
// servers, and the accounts signed in here that can vouch for the user
// there. Self-hosted web clients only: boson.chat's own app has nowhere
// else to come from.
function useHomeFederation(accounts: NetworkAccounts | null | undefined, home: HomeNetwork): {
  link: NetworkLink | null;
  homes: HomeAccount[];
} {
  const [link, setLink] = useState<NetworkLink | null>(null);
  const [homes, setHomes] = useState<HomeAccount[]>([]);
  useEffect(() => {
    setLink(null);
    setHomes([]);
    if (!accounts?.supported || !home.selfHosted) return;
    let live = true;
    let off = (): void => {};
    accounts.mainNetworkLink().then((l) => {
      if (!live || !l || !acceptsFederation(l.federation, l.authUrl)) return;
      setLink(l);
      const load = (): void => {
        accounts.homeAccounts(l).then((h) => {
          if (live) setHomes((prev) => (sameHomes(prev, h) ? prev : h));
        }, () => {});
      };
      load();
      off = accounts.subscribe(load);
    }, () => {});
    return () => { live = false; off(); };
  }, [accounts, home.selfHosted]);
  return { link, homes };
}

function sameHomes(a: HomeAccount[], b: HomeAccount[]): boolean {
  return a.length === b.length && a.every((h, i) => h.identity === b[i]!.identity);
}

// Above the home network's sign-in form: "Continue as alice@boson.chat"
// (federated sign-in, FederatedSignIn) for each account that can vouch,
// else "Continue with boson.chat" (sign in there first, then come back).
function HomeFederation({ accounts, link, homes, home, signIn, offerBosonChat, autoStart, note, onBosonChat }: {
  accounts: NetworkAccounts;
  link: NetworkLink;
  homes: HomeAccount[];
  home: HomeNetwork;
  // Signs the app's own account in as that home account.
  signIn: (h: HomeAccount) => Promise<void>;
  offerBosonChat: boolean;
  autoStart: string | null;
  note: string | null;
  onBosonChat: () => void;
}) {
  const divider = `or sign in to ${home.name}`;
  return (
    <>
      {note && <div class="login-error" role="alert">{note}</div>}
      {homes.length > 0 ? (
        <FederatedSignIn
          accounts={accounts}
          link={link}
          name={home.name}
          homes={homes}
          signIn={signIn}
          autoStart={autoStart}
          divider={divider}
          onSignedIn={() => {}}
        />
      ) : offerBosonChat ? (
        <section class="netauth-fed login-fed" aria-label={`Sign in to ${home.name} with a ${BOSON_CHAT_HOME.domain} account`}>
          <button type="button" class="netauth-fed-choice login-fed-boson" onClick={onBosonChat}>
            <span class="netauth-fed-avatar login-fed-mark" aria-hidden="true">{BOSON_CHAT_HOME.domain[0]!.toUpperCase()}</span>
            <span class="netauth-fed-body">
              <span class="netauth-fed-title">Continue with {BOSON_CHAT_HOME.domain}</span>
              <span class="netauth-fed-sub">Sign in or sign up there, then come back. No password is shared.</span>
            </span>
            <ChevronRight size={16} class="netauth-fed-chevron" aria-hidden="true" />
          </button>
          <div class="login-sso-divider netauth-fed-divider" aria-hidden="true"><span>{divider}</span></div>
        </section>
      ) : null}
    </>
  );
}
