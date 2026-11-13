import { useEffect, useMemo, useState } from 'preact/hooks';
import { useAuthService } from '../../modules/auth';
import type { DirectoryService } from '../../modules/directory';
import type { IdentityService } from '../../modules/identity';
import { Button, Card, Field, Input, Logo, Tabs, WarningBanner } from '@boson/shared';
import { LoginBloc, type LoginMode } from './LoginBloc';
import { emitGuestChange, saveGuestSession } from '../../modules/guest/guest';
import { sanitizeIrcNick } from '../../modules/identity/nick';
import './LoginScreen.css';

interface Props {
  directory: DirectoryService;
  identity: IdentityService;
}

export function LoginScreen({ directory, identity }: Props) {
  const auth = useAuthService();
  const bloc = useMemo(() => new LoginBloc({ auth, directory, identity }), [auth, directory, identity]);
  const [state, setState] = useState(() => bloc.getState());
  useEffect(() => bloc.subscribe(setState), [bloc]);

  const {
    mode, login, username, email, password, confirmPassword, error, unrecoverable, recoverable, busy,
    awaitingConfirmation, forgotOpen, notice,
  } = state;
  const usernameProblem = bloc.usernameProblem();
  const [recoveryInput, setRecoveryInput] = useState('');

  // Guest-mode local state. The user clicks "Continue as guest" to reveal a
  // single nick field; submitting it writes a localStorage record and emits
  // an event that the App router picks up to swap into the directory.
  const [guestPrompt, setGuestPrompt] = useState(false);
  const [guestNick, setGuestNick] = useState('');

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
      <div class="login-screen">
        <div class="login-container">
          <Logo />
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
              <div class="login-confirm-actions">
                <Button type="button" variant="ghost" disabled={busy} onClick={() => bloc.cancelAwaitingConfirmation()}>
                  Back
                </Button>
                <Button type="button" variant="ghost" disabled={busy} onClick={() => { void bloc.resendVerification(); }}>
                  Resend email
                </Button>
                <Button type="button" variant="primary" disabled={busy} loading={busy} onClick={() => { void bloc.continueAfterVerification(); }}>
                  Continue
                </Button>
              </div>
            </div>
          </Card>
        </div>
      </div>
    );
  }

  if (forgotOpen) {
    return (
      <div class="login-screen">
        <div class="login-container">
          <Logo />
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

  return (
    <div class="login-screen">
      <div class="login-container">
        <Logo />

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
                loading={busy && mode === 'login'}
                onClick={(e) => { if (mode === 'login') onSubmit('signin', e); else { e.preventDefault(); bloc.setMode('login'); } }}
              >
                Sign in
              </Button>
              <Button
                type={mode === 'signup' ? 'submit' : 'button'}
                variant={mode === 'signup' ? 'primary' : 'ghost'}
                fullWidth
                disabled={busy}
                loading={busy && mode === 'signup'}
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
          ) : (
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
